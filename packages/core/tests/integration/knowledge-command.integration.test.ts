import { describe, expect, spyOn, test } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import { BatchService } from "../../src/batch/batch";
import { entityWriteOptions as write, expectAsyncRelayError } from "./helpers/entity-fixture";
import { withKnowledgeFixture } from "./helpers/knowledge-fixture";

describe("Async команды знаний и разреженный overlay", () => {
  test("app+board rev2, участие и снятый раздел проходят один отложенный load/commit путь", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const project = service.get("project");
      /**
       * Настоящие SQLite-загрузки завершаются только после асинхронной границы.
       */
      const load = db.commands.load.bind(db.commands);
      /**
       * Сохраняет настоящий guarded commit с отложенным входом.
       */
      const commit = db.commands.commit.bind(db.commands);
      const loads = spyOn(db.commands, "load").mockImplementation(async (request) => {
        await Promise.resolve();
        return load(request);
      });
      const commits = spyOn(db.commands, "commit").mockImplementation(async (plan) => {
        await Promise.resolve();
        return commit(plan);
      });
      const syncRead = spyOn(db, "get");
      try {
        const result = await new BatchService(db).execute(
          {
            version: 1,
            operations: [
              { op: "application.create", as: "app", input: { name: "Web", slug: "web" } },
              { op: "feature.create", as: "feature", input: { name: "Поиск" } },
              {
                op: "scenario.create",
                as: "scenario",
                input: { name: "По имени", feature: { $ref: "feature" } },
              },
              {
                op: "application.participation.replace",
                ref: { $ref: "app" },
                ifRevision: { $revision: "app" },
                input: { targets: [{ $ref: "scenario" }, { $ref: "feature" }] },
              },
              {
                op: "document.section.create",
                as: "section",
                ifRevision: project.revision,
                input: { name: "Руководства" },
              },
              {
                op: "document.create",
                as: "document",
                input: {
                  name: "Поиск",
                  body: "Полное описание",
                  sectionId: { $ref: "section" },
                  targets: [{ $ref: "feature" }],
                },
              },
              {
                op: "document.section.remove",
                ifRevision: { $revision: "section" },
                input: { id: { $ref: "section" } },
              },
              {
                op: "document.update",
                ref: { $ref: "document" },
                ifRevision: { $revision: "document" },
                input: { summary: "Уточнение" },
              },
            ],
          },
          { actor: "author", operationKey: "knowledge-overlay" },
        );

        expect(commits).toHaveBeenCalledTimes(1);
        expect(syncRead).not.toHaveBeenCalled();
        expect(result.items[0]).toMatchObject({
          kind: "application",
          revision: 2,
          outputs: [{ kind: "board", revision: 1 }],
        });
        const firstEffects = commits.mock.calls[0]?.[0].transitions[0]?.effects;
        expect(
          firstEffects?.map((effect) =>
            effect.kind === "entity" ? [effect.after.kind, effect.after.revision] : effect.kind,
          ),
        ).toEqual([
          ["application", 1],
          ["board", 1],
          ["application", 2],
        ]);
        const application = result.entities.find((record) => record.kind === "application");
        if (application === undefined) {
          throw new Error("В результате отсутствует созданное приложение");
        }
        expect(application).toMatchObject({ revision: 3 });
        const implementations = result.entities.filter(
          (record) => record.kind === "implementation",
        );
        expect(implementations).toHaveLength(2);
        expect(application.data.implementationIds).toEqual(
          implementations.map((record) => record.id).sort(),
        );
        const document = result.entities.find((record) => record.kind === "document");
        expect(document).toMatchObject({
          revision: 2,
          data: { sectionId: null, summary: "Уточнение", body: "Полное описание" },
        });
        const documentEffects = commits.mock.calls[0]?.[0].transitions
          .flatMap((transition) => transition.effects)
          .filter((effect) => effect.kind === "entity" && effect.after.kind === "document");
        expect(
          documentEffects?.map((effect) =>
            effect.kind === "entity" ? effect.after.data.sectionId : null,
          ),
        ).toEqual([result.items[4]?.id, result.items[4]?.id]);
        const selectors = loads.mock.calls.flatMap(([request]) => request.selectors);
        expect(selectors.filter((selector) => selector.kind === "field")).toEqual([
          {
            kind: "field",
            entityKind: "implementation",
            field: "applicationId",
            value: application.id,
          },
        ]);
        expect(selectors.some((selector) => selector.kind === "kind")).toBe(false);
      } finally {
        syncRead.mockRestore();
        commits.mockRestore();
        loads.mockRestore();
      }
    });
  });

  test("phantom истории приложения отклоняет готовый план без свежего CAS и расхода ключа", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const feature = await service.create("feature", { name: "Исходная цель" }, "author");
      const next = await service.create("feature", { name: "Выбранная цель" }, "author");
      const application = await service.create(
        "application",
        { name: "Web", slug: "web" },
        "author",
      );
      const previous = await service.create(
        "implementation",
        { application: application.id, target: feature.id, title: "Прежний вклад" },
        "author",
      );
      const owner = service.get("application", application.id);
      const writer = ProjectDatabase.open(db.path);
      const generation = db.getGeneration();
      // Независимая историческая запись не меняет активные ID и ревизию приложения.
      const historical = {
        ...previous,
        id: crypto.randomUUID(),
        key: "HISTORICAL-FI",
        revision: 1,
        data: { ...previous.data, active: false, targetId: next.id, featureId: next.id },
      };
      /**
       * Сохраняет точный подготовленный план после чужой вставки, без повторного расчёта.
       */
      const commit = db.commands.commit.bind(db.commands);
      const intercepted = spyOn(db.commands, "commit").mockImplementation(async (plan) => {
        writer.insert(historical);
        return commit(plan);
      });
      try {
        const error = await expectAsyncRelayError(
          () =>
            new BatchService(db).execute(
              {
                version: 1,
                operations: [
                  {
                    op: "application.participation.replace",
                    ref: owner.id,
                    ifRevision: owner.revision,
                    input: { targets: [next.id] },
                  },
                ],
              },
              { actor: "editor", operationKey: "phantom-participation" },
            ),
          "COMMAND_CONTEXT_CHANGED",
        );

        expect(error.details).toMatchObject({
          selector: {
            kind: "field",
            entityKind: "implementation",
            field: "applicationId",
            value: owner.id,
          },
        });
        expect(intercepted).toHaveBeenCalledTimes(1);
        expect(service.get("application", owner.id)).toEqual(owner);
        expect(service.get("implementation", previous.id)).toEqual(previous);
        expect(service.get("implementation", historical.id)).toEqual(historical);
        expect(db.getGeneration()).toBe(generation + 1);
        expect(db.getBatchReceipt("phantom-participation")).toBeUndefined();
        expect(db.nextKey("WEB-FI")).toBe("WEB-FI-2");
      } finally {
        intercepted.mockRestore();
        writer.close();
      }
    });
  });

  test("явный ref singleton не игнорируется точечным фасадом", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const product = service.get("product");
      const generation = db.getGeneration();

      await expectAsyncRelayError(
        () =>
          service.update(
            "product",
            "missing-product",
            { summary: "Не записывать" },
            write(product),
          ),
        "NOT_FOUND",
      );
      await expectAsyncRelayError(
        () => service.rename("product", "project:PROJECT", "NEW", write(product)),
        "INVALID_ARGUMENT",
      );

      expect(service.get("product")).toEqual(product);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});
