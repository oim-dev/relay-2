import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { ProjectDatabase } from "../../src/database/project-database";
import {
  componentCriterion,
  componentTask,
  withComponentsFixture,
} from "./helpers/components-fixture";
import { createLegacyComponents } from "./helpers/components-legacy-fixture";

describe("Lossless Unicode на границе SQLite v4", () => {
  test("comment title/body с lone surrogate сохраняются в SQL carrier, public reads, outbox и restore", () => {
    withComponentsFixture(({ db, raw, directory }) => {
      const task = componentTask("task", "T-1", []);
      db.insert(task);
      const comment = {
        id: "comment",
        title: "Заголовок\ud800",
        body: "\ud801\r\n\t😀 e\u0301  \udfff",
        createdAt: task.createdAt,
        createdBy: "author",
      };

      const appended = db.appendTaskComment(task.id, comment);

      expect(appended.data.comments).toEqual([comment]);
      expect(db.get(task.id)?.data.comments).toEqual([comment]);
      expect(db.getMany([task.id])[0]?.data.comments).toEqual([comment]);
      expect(
        db.listPage("task", { offset: 0, limit: 1, sort: "key" }).items[0]?.data.comments,
      ).toEqual([comment]);
      expect(raw.query("SELECT title,body FROM task_comments WHERE id='comment'").get()).toEqual({
        title: "",
        body: "",
      });
      expect(
        raw
          .query(
            "SELECT title_json,body_json FROM replication_comment_text WHERE comment_id='comment'",
          )
          .get(),
      ).toEqual({
        title_json: JSON.stringify(comment.title),
        body_json: JSON.stringify(comment.body),
      });
      expect(db.getReplicationOutbox().at(-1)?.comments[0]?.comment).toEqual(comment);
      const snapshot = db.captureReplication();
      expect(snapshot.comments[0]?.comment).toEqual(comment);
      const restored = ProjectDatabase.createReplica(
        join(directory, "unicode-restored.sqlite"),
        db.projectId,
      );
      try {
        restored.bootstrapReplication(snapshot);
        expect(restored.get(task.id)?.data.comments).toEqual([comment]);
        expect(restored.getReplicationOutbox()).toEqual([]);
      } finally {
        restored.close();
      }
      expect(() =>
        raw
          .query("UPDATE replication_comment_text SET body_json=? WHERE comment_id='comment'")
          .run(JSON.stringify("Подмена")),
      ).toThrow();
      db.appendTaskComment(task.id, {
        ...comment,
        id: "plain",
        title: "",
        body: "Обычный immutable текст",
      });
      expect(() =>
        raw
          .query("INSERT INTO replication_comment_text(comment_id,title_json) VALUES('plain',?)")
          .run(JSON.stringify("Задняя подмена title")),
      ).toThrow();
      expect(db.get(task.id)?.data.comments).toEqual([
        comment,
        { ...comment, id: "plain", title: "", body: "Обычный immutable текст" },
      ]);
    });
  });

  test("JSON имена, тела и имена участников остаются lossless и точно фильтруются", () => {
    withComponentsFixture(({ db }) => {
      const title = "Название\ud800";
      const criterion = {
        ...componentCriterion("criterion"),
        title: "Критерий\ud801",
        description: "Тело\udfff",
      };
      const task = {
        ...componentTask("json-text", "T-1", [criterion]),
        data: {
          ...componentTask("json-text", "T-1", [criterion]).data,
          title,
          description: "Body\ud800",
        },
      };
      db.insert(task);
      const plan = {
        ...task,
        id: "plan",
        kind: "work-plan" as const,
        key: "PLN-1",
        data: { title: "План\ud800", participants: ["Имя\udfff"], stages: [], scope: [] },
      };
      db.insert(plan);

      expect(db.get(task.id)?.data).toEqual({ ...task.data, comments: [] });
      expect(db.listByField("task", "title", title).map((record) => record.id)).toEqual([task.id]);
      expect(db.hasArrayItemByField("task", "acceptanceCriteria", "title", criterion.title)).toBe(
        true,
      );
      expect(db.get(plan.id)?.data).toEqual(plan.data);
    });
  });

  test("plain identity/author и scoped part ID отклоняются до lossy binding, а valid U+FFFD не затрагивается", () => {
    withComponentsFixture(({ db }) => {
      const valid = componentTask("real���", "T-VALID", []);
      db.insert(valid);
      const generation = db.getGeneration();
      const queue = db.getReplicationOutbox();

      expect(() => db.get("real\ud800")).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(() => db.getIdentity("real\ud801")).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(() => db.insert(componentTask("bad\ud800", "T-BAD", []))).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(() =>
        db.insert({ ...componentTask("bad-author", "T-AUTHOR", []), createdBy: "author\udfff" }),
      ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
      expect(() =>
        db.insert(componentTask("bad-part", "T-PART", [componentCriterion("criterion\ud800")])),
      ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

      expect(db.getIdentity(valid.id)?.id).toBe(valid.id);
      expect(db.getIdentity("bad-part")).toBeUndefined();
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(queue);
    });
  });

  test.each([2, 3] as const)(
    "malformed legacy UTF-8 в v%d блокирует миграцию без изменения исходных bytes/версии/схемы",
    (version) => {
      withComponentsFixture(({ directory }) => {
        const path = join(directory, `invalid-${version}.sqlite`);
        createLegacyComponents(path, version);
        const raw = new Database(path, { strict: true });
        try {
          raw
            .query(
              "INSERT INTO task_comments(id,task_id,title,body,created_at,created_by) VALUES(?,?,?,?,?,?)",
            )
            .run("invalid", "legacy-task", "", "x\ud800", "2026-10-24T01:00:00.000Z", "author");
          const bytes = raw
            .query("SELECT hex(CAST(body AS BLOB)) AS bytes FROM task_comments WHERE id='invalid'")
            .get();
          const structure = raw.query("SELECT name,sql FROM sqlite_schema ORDER BY name").all();
          const outbox =
            version === 3 ? raw.query("SELECT json FROM replication_outbox").all() : [];

          expect(() => ProjectDatabase.open(path)).toThrow(
            expect.objectContaining({
              code: "CORRUPT_DATA",
              details: expect.objectContaining({ table: "task_comments", column: "body" }),
            }),
          );

          expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: version });
          expect(
            raw
              .query(
                "SELECT hex(CAST(body AS BLOB)) AS bytes FROM task_comments WHERE id='invalid'",
              )
              .get(),
          ).toEqual(bytes);
          expect(raw.query("SELECT name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(
            structure,
          );
          if (version === 3) {
            expect(raw.query("SELECT json FROM replication_outbox").all()).toEqual(outbox);
          }
        } finally {
          raw.close();
        }
      });
    },
  );
});
