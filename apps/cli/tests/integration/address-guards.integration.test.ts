import { describe, expect, spyOn, test } from "bun:test";
import { KnowledgeService, QueryService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { objectValue } from "./helpers/responses";

const group = "git-sync-implementation/cli-runtime/commands";

describe("Адресные guards subject CLI", () => {
  test("single передаёт прочитанный ID отдельно от CAS и сохраняет прежнюю форму entity", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const document = await fixture.withDatabase(
        project,
        async (db) =>
          await new KnowledgeService(db).create(
            "document",
            { name: "Исходный документ", body: "Прежнее содержание" },
            "fixture",
          ),
      );
      const argv = [
        "document",
        "update",
        document.key,
        "--if-revision",
        String(document.revision),
        "--body",
        "Новое содержание",
      ];
      const rejected = await fixture.error(
        [
          ...argv,
          "--expected-addresses",
          JSON.stringify([{ ref: document.key, expectedId: "another-entity" }]),
        ],
        4,
      );

      expect(rejected.code).toBe("ADDRESS_CHANGED");
      expect(
        fixture.withDatabase(project, (db) =>
          new KnowledgeService(db).get("document", document.id),
        ),
      ).toEqual(document);

      const updated = await fixture.entity([
        ...argv,
        "--expected-addresses",
        JSON.stringify([{ ref: document.key, expectedId: document.id }]),
      ]);
      expect(updated).toMatchObject({
        id: document.id,
        key: document.key,
        kind: "document",
        revision: document.revision + 1,
        data: { name: "Исходный документ", body: "Новое содержание" },
      });
    }, group);
  });

  test("replay batch возвращает первоначальную квитанцию до stale address guard и CAS", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const document = await fixture.withDatabase(
        project,
        async (db) =>
          await new KnowledgeService(db).create(
            "document",
            { name: "Квитанция", body: "Исходное" },
            "fixture",
          ),
      );
      const input = JSON.stringify({
        version: 1,
        operations: [
          {
            op: "document.update",
            ref: document.key,
            ifRevision: document.revision,
            input: { body: "Сохранено пакетом" },
          },
        ],
      });
      const argv = [
        "batch",
        "--input",
        input,
        "--operation-key",
        "guarded-batch",
        "--return",
        "full",
      ];
      const first = await fixture.success([
        ...argv,
        "--expected-addresses",
        JSON.stringify([{ ref: document.key, expectedId: document.id }]),
      ]);
      const initialReceipt = objectValue(first.data);
      await fixture.withDatabase(project, async (db) => {
        const knowledge = new KnowledgeService(db);
        const current = knowledge.get("document", document.id);
        await knowledge.update(
          "document",
          document.id,
          { body: "Позднейшая редакция" },
          { actor: "later-author", ifRevision: current.revision },
        );
      });
      const beforeReplay = fixture.withDatabase(project, (db) => ({
        document: new KnowledgeService(db).get("document", document.id),
        generation: db.getGeneration(),
      }));

      const replayed = await fixture.success([
        ...argv,
        "--expected-addresses",
        JSON.stringify([{ ref: document.key, expectedId: "stale-reader-id" }]),
      ]);

      expect(replayed.data).toEqual({ ...initialReceipt, replayed: true });
      expect(
        fixture.withDatabase(project, (db) => ({
          document: new KnowledgeService(db).get("document", document.id),
          generation: db.getGeneration(),
        })),
      ).toEqual(beforeReplay);
    }, group);
  });

  test("scope остаётся исходной строкой до command loader и проверяется тем же address guard", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const feature = await fixture.withDatabase(
        project,
        async (db) =>
          await new KnowledgeService(db).create("feature", { name: "Область плана" }, "fixture"),
      );
      const query = spyOn(QueryService.prototype, "get");
      try {
        const plan = await fixture.entity([
          "plan",
          "create",
          "--title",
          "План",
          "--scope",
          feature.key,
          "--expected-addresses",
          JSON.stringify([{ ref: feature.key, expectedId: feature.id }]),
        ]);

        expect(plan.data.scope).toEqual([{ kind: "feature", id: feature.id }]);
        expect(query).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
      const rejected = await fixture.error(
        [
          "plan",
          "create",
          "--title",
          "Устаревший читатель",
          "--scope",
          feature.key,
          "--expected-addresses",
          JSON.stringify([{ ref: feature.key, expectedId: "stale-reader-id" }]),
        ],
        4,
      );
      expect(rejected.code).toBe("ADDRESS_CHANGED");
      expect(
        fixture.withDatabase(project, (db) =>
          db.list("work-plan").map((entry) => entry.data.title),
        ),
      ).toEqual(["План"]);
    }, group);
  });
});
