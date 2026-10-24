import { describe, expect, test } from "bun:test";
import { BatchService, KnowledgeService } from "@relay/core";
import { RelayError } from "@relay/contracts";
import { getBatchOperationContract } from "../../src/commands/batch/help-contract";
import { withCliFixture } from "./helpers/cli-fixture";

describe("Предметное исполнение примеров справки batch", () => {
  test("пример product.create использует явную ревизию пустого паспорта и откатывается", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      await fixture.withDatabase(project, async (db) => {
        const before = db.list();
        const generation = db.getGeneration();
        const example = getBatchOperationContract("product.create").example;

        const checked = await new BatchService(db).execute(
          { version: 1, operations: [example] },
          { actor: "agent", check: true },
        );

        expect(example.ifRevision).toBe(1);
        expect(checked.status).toBe("checked");
        expect(checked.entities).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "product",
              revision: 2,
              data: {
                name: "Каталог товаров",
                summary: "Поиск и сравнение товаров",
                description:
                  "## Назначение\nПомочь покупателю выбрать товар.\n\n## Границы\nПоиск и сравнение; оплата описывается отдельно.",
              },
            }),
          ]),
        );
        expect(db.list()).toEqual(before);
        expect(db.getGeneration()).toBe(generation);
      });
    }, "batch-help-navigation");
  });

  test("готовые scope, relations, criteria и этап выполняются одним check без подстановки ревизий", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      await fixture.withDatabase(project, async (db) => {
        const feature = await new KnowledgeService(db).create(
          "feature",
          { name: "Поиск" },
          "agent",
        );
        expect(feature.key).toBe("FEATURE-1");
        const before = db.list();
        const generation = db.getGeneration();
        const operations = [
          "plan.create",
          "document.create",
          "task.create",
          "plan.stage.create",
        ].map((op) => getBatchOperationContract(op).example);

        const checked = await new BatchService(db).execute(
          { version: 1, operations },
          { actor: "agent", check: true },
        );

        expect(checked.status).toBe("checked");
        expect(checked.items.map((item) => item.op)).toEqual([
          "plan.create",
          "document.create",
          "task.create",
          "plan.stage.create",
        ]);
        expect(checked.entities.find((entity) => entity.kind === "work-plan")).toMatchObject({
          key: "PLN-1",
          revision: 2,
          data: {
            scope: [{ kind: "feature", id: feature.id }],
            stages: [{ title: "Реализация и проверка", taskIds: [] }],
          },
        });
        expect(checked.entities.find((entity) => entity.kind === "document")).toMatchObject({
          data: { relations: [{ target: { kind: "feature", id: feature.id }, type: "documents" }] },
        });
        expect(checked.entities.find((entity) => entity.kind === "task")).toMatchObject({
          data: {
            parentId: null,
            targets: [feature.id],
            acceptanceCriteria: [{ title: "Запрос сохраняется", completed: false }],
          },
        });
        expect(db.list()).toEqual(before);
        expect(db.getGeneration()).toBe(generation);
      });
    }, "batch-help-navigation");
  });

  test("пример session.start сохраняет operator, а явный description:null не считается пропуском", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      await fixture.withDatabase(project, async (db) => {
        const before = db.list();
        const generation = db.getGeneration();
        const example = getBatchOperationContract("session.start").example;
        const batch = new BatchService(db);

        const checked = await batch.execute(
          { version: 1, operations: [example] },
          { actor: "agent", check: true },
        );

        expect(checked.entities).toEqual([
          expect.objectContaining({
            kind: "work-session",
            data: expect.objectContaining({
              status: "open",
              runs: [
                expect.objectContaining({
                  actor: "agent",
                  operator: { name: "Ирина", email: "irina@example.com", source: "explicit" },
                }),
              ],
            }),
          }),
        ]);
        try {
          await batch.execute(
            {
              version: 1,
              operations: [{ ...example, input: { ...example.input, description: null } }],
            },
            { actor: "agent", check: true },
          );
          throw new Error("Ожидался отказ явного null в description истории");
        } catch (error) {
          expect(error).toBeInstanceOf(RelayError);
          expect(error).toMatchObject({ code: "INVALID_INPUT", exitCode: 2 });
        }
        expect(db.list()).toEqual(before);
        expect(db.getGeneration()).toBe(generation);
      });
    }, "batch-help-navigation");
  });
});
