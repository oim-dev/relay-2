import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectDatabase } from "../../src/database/project-database";
import {
  componentCriterion,
  componentTask,
  withComponentsFixture,
} from "./helpers/components-fixture";
import { createLegacyComponents } from "./helpers/components-legacy-fixture";
import {
  ProjectDatabaseFixture,
  createTask,
  expectRelayError,
  requireRecord,
} from "./helpers/project-database-fixture";

describe("Сохранение Unicode без потерь на границе SQLite", () => {
  test("начальный BOM title/body комментария сохраняется в TEXT, outbox и восстановленной реплике", () => {
    const fixture = new ProjectDatabaseFixture("comment-bom", "database-redesign");
    try {
      const db = fixture.create();
      const task = createTask(db);
      db.insert(task);
      const comment = {
        id: "bom-comment",
        title: "\ufeffТочный заголовок",
        body: "\ufeff# Точное тело\r\n",
        createdAt: task.createdAt,
        createdBy: "original-author",
      };

      const appended = db.appendTaskComment(task.id, comment);

      expect(appended.data.comments).toEqual([comment]);
      fixture.withRaw((raw) => {
        expect(
          raw
            .query(
              "SELECT title,title_json,body,body_json FROM task_comments WHERE id='bom-comment'",
            )
            .get(),
        ).toEqual({
          title: comment.title,
          title_json: null,
          body: comment.body,
          body_json: null,
        });
      });
      const changeset = db.getReplicationOutbox().at(-1);
      expect(changeset?.comments[0]?.comment).toEqual(comment);
      expect(changeset?.transitions?.[0]?.comments[0]?.comment).toEqual(comment);
      const snapshot = db.captureReplication();
      expect(snapshot.comments).toEqual([{ taskId: task.id, after: null, comment }]);
      const restored = ProjectDatabase.createReplica(
        join(fixture.directory, "bom-restored.sqlite"),
        db.projectId,
      );
      try {
        restored.bootstrapReplication(snapshot);
        expect(restored.get(task.id)?.data.comments).toEqual([comment]);
        expect(restored.captureReplication().comments).toEqual(snapshot.comments);
        expect(restored.getReplicationOutbox()).toEqual([]);
      } finally {
        restored.close();
      }
      db.close();
      expect(fixture.open().get(task.id)?.data.comments).toEqual([comment]);
    } finally {
      fixture.close();
    }
  });

  test("непарные суррогаты комментария сохраняются в SQL, публичных чтениях, outbox и восстановленной реплике", () => {
    withComponentsFixture(({ db, raw, directory }) => {
      const task = componentTask("task", "T-1", []);
      task.data.boardId = requireRecord(db, "BOARD-PRODUCT").id;
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
      expect(
        raw
          .query("SELECT title,title_json,body,body_json FROM task_comments WHERE id='comment'")
          .get(),
      ).toEqual({
        title: null,
        title_json: JSON.stringify(comment.title),
        body: null,
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
          .query("UPDATE task_comments SET body_json=? WHERE id='comment'")
          .run(JSON.stringify("Подмена")),
      ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_TRIGGER" }));
      db.appendTaskComment(task.id, {
        ...comment,
        id: "plain",
        title: "",
        body: "Обычный immutable текст",
      });
      expect(
        raw
          .query("SELECT title,title_json,body,body_json FROM task_comments WHERE id='plain'")
          .get(),
      ).toEqual({
        title: "",
        title_json: null,
        body: "Обычный immutable текст",
        body_json: null,
      });
      expect(() =>
        raw
          .query("UPDATE task_comments SET title=NULL,title_json=? WHERE id='plain'")
          .run(JSON.stringify("Задняя подмена title")),
      ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_TRIGGER" }));
      expect(db.get(task.id)?.data.comments).toEqual([
        comment,
        { ...comment, id: "plain", title: "", body: "Обычный immutable текст" },
      ]);
    });
  });

  test("имена, тексты и участники с непарными суррогатами сохраняются и точно фильтруются", () => {
    withComponentsFixture(({ db }) => {
      const title = "Название\ud800";
      const criterion = {
        ...componentCriterion("criterion"),
        title: "Критерий\ud801",
        description: "Тело\udfff",
      };
      const initialTask = componentTask("json-text", "T-1", [criterion]);
      const task = {
        ...initialTask,
        data: {
          ...initialTask.data,
          boardId: requireRecord(db, "BOARD-PRODUCT").id,
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
        data: {
          projectId: db.projectId,
          title: "План\ud800",
          summary: "",
          goal: "",
          rationale: "",
          boundaries: "",
          expectedResult: "",
          participants: ["Имя\udfff"],
          stages: [],
          scope: [],
          result: "",
          status: "draft",
          startedAt: null,
          closedAt: null,
        },
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

  test("непарные суррогаты в ID и авторе отклоняются без записи, а допустимый U+FFFD сохраняется", () => {
    withComponentsFixture(({ db }) => {
      const valid = componentTask("real���", "T-VALID", []);
      valid.data.boardId = requireRecord(db, "BOARD-PRODUCT").id;
      db.insert(valid);
      const generation = db.getGeneration();
      const queue = db.getReplicationOutbox();

      expect(() => db.get("real\ud800")).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(() => db.getIdentity("real\ud801")).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(() => db.insert({ ...valid, id: "bad\ud800", key: "T-BAD" })).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(() =>
        db.insert({ ...valid, id: "bad-author", key: "T-AUTHOR", createdBy: "author\udfff" }),
      ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
      expect(() =>
        db.insert({
          ...valid,
          id: "bad-part",
          key: "T-PART",
          data: {
            ...valid.data,
            acceptanceCriteria: [componentCriterion("criterion\ud800")],
          },
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

      expect(db.getIdentity(valid.id)?.id).toBe(valid.id);
      expect(db.getIdentity("bad-part")).toBeUndefined();
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(queue);
    });
  });

  test.each([2, 3] as const)(
    "v%d с повреждённым UTF-8 отклоняется по версии без исправления исходных байтов",
    (version) => {
      const fixture = new ProjectDatabaseFixture("legacy-unicode", "database-redesign");
      try {
        createLegacyComponents(fixture.path, version);
        fixture.withRaw((raw) => {
          // ED A0 80 кодирует недопустимый UTF-8 surrogate; CAST исключает нормализацию драйвером.
          raw.exec(`
            INSERT INTO task_comments(id,task_id,title,body,created_at,created_by)
            VALUES('invalid','legacy-task','',CAST(X'78EDA080' AS TEXT),
              '2026-10-24T01:00:00.000Z','author');
            PRAGMA journal_mode=DELETE;
          `);
          expect(
            raw
              .query(
                "SELECT hex(CAST(body AS BLOB)) AS bytes FROM task_comments WHERE id='invalid'",
              )
              .get(),
          ).toEqual({ bytes: "78EDA080" });
        });
        const before = readFileSync(fixture.path);

        const failure = expectRelayError(() => fixture.open(), "SCHEMA_VERSION_UNSUPPORTED");

        expect(failure.details).toMatchObject({ expectedVersion: 6, actualVersion: version });
        expect(readFileSync(fixture.path)).toEqual(before);
        expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);
        fixture.withRaw((raw) => {
          expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: version });
          expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
          expect(
            raw
              .query(
                "SELECT hex(CAST(body AS BLOB)) AS bytes FROM task_comments WHERE id='invalid'",
              )
              .get(),
          ).toEqual({ bytes: "78EDA080" });
        });
      } finally {
        fixture.close();
      }
    },
  );
});
