import { describe, expect, spyOn, test } from "bun:test";
import { readVersionedEntity } from "../../src/commands/command-versioned-read";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { entityWriteOptions as write, expectAsyncRelayError } from "./helpers/entity-fixture";
import { withKnowledgeFixture } from "./helpers/knowledge-fixture";

const invalidRevisions = [
  { name: "нулевой CAS с token метода", ifRevision: 0, inherited: false },
  { name: "дробный CAS с token конструктора", ifRevision: 1.5, inherited: true },
  { name: "NaN CAS с token метода", ifRevision: Number.NaN, inherited: false },
] as const;

describe("Переносимые условия точечных writers знаний", () => {
  test("version-only update сохраняет документ и отвергает прежний token до no-op", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const initial = await service.create("document", { name: "Документ", body: "До" }, "author");
      const observed = await readVersionedEntity(db.commands, initial.id, "document");
      const options = { actor: "editor", expectedVersion: observed.versions.aggregateVersion };

      const updated = await service.update("document", initial.id, { body: "После" }, options);
      const generation = db.getGeneration();
      await expectAsyncRelayError(
        () => service.update("document", initial.id, { body: "После" }, options),
        "VERSION_CONFLICT",
      );

      expect(updated).toMatchObject({
        revision: initial.revision + 1,
        updatedBy: "editor",
        data: { body: "После" },
      });
      expect(service.get("document", initial.id)).toEqual(updated);
      expect(db.getGeneration()).toBe(generation);
      expect(options).not.toHaveProperty("ifRevision");
    });
  });

  test("token конструктора поддерживает sections, а token rename метода имеет приоритет", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const project = await readVersionedEntity(db.commands, db.projectId, "project");
      const inherited = new KnowledgeService(db, {
        expectedVersion: project.versions.aggregateVersion,
      });

      const changed = await inherited.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        { actor: "author" },
      );
      await expectAsyncRelayError(
        () => inherited.rename("project", undefined, "RENAMED", { actor: "editor" }),
        "VERSION_CONFLICT",
      );
      const current = await readVersionedEntity(db.commands, db.projectId, "project");
      const renamed = await inherited.rename("project", undefined, "RENAMED", {
        actor: "editor",
        expectedVersion: current.versions.aggregateVersion,
      });
      const generation = db.getGeneration();
      const validDefault = await readVersionedEntity(db.commands, db.projectId, "project");
      const facade = new KnowledgeService(db, {
        expectedVersion: validDefault.versions.aggregateVersion,
      });
      await expectAsyncRelayError(
        () =>
          facade.rename("project", undefined, "OTHER", { actor: "editor", expectedVersion: "" }),
        "INVALID_ARGUMENT",
      );

      expect(changed.data.documentSections).toEqual([{ id: "guides", name: "Руководства" }]);
      expect(renamed).toMatchObject({
        id: db.projectId,
        key: "RENAMED",
        revision: changed.revision + 1,
        data: changed.data,
      });
      expect(service.get("project")).toEqual(renamed);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("публичные link options принимают version-only и проверяют token самого документа", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const feature = await service.create("feature", { name: "Цель" }, "author");
      const document = await service.create(
        "document",
        { name: "Документ", body: "Содержание" },
        "author",
      );
      const observed = await readVersionedEntity(db.commands, document.id, "document");

      const linked = await service.linkDocument(document.id, feature.id, {
        actor: "editor",
        expectedVersion: observed.versions.aggregateVersion,
        type: "documents",
        description: "Основание",
      });
      const generation = db.getGeneration();
      await expectAsyncRelayError(
        () =>
          service.linkDocument(document.id, feature.id, {
            actor: "editor",
            expectedVersion: observed.versions.aggregateVersion,
            remove: true,
          }),
        "VERSION_CONFLICT",
      );

      expect(linked.data.relations).toEqual([
        {
          target: { kind: "feature", id: feature.id },
          type: "documents",
          description: "Основание",
        },
      ]);
      expect(service.get("document", document.id)).toEqual(linked);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("участие и legacy implementation.create используют переносимый token приложения", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const feature = await service.create("feature", { name: "Выбранная цель" }, "author");
      const another = await service.create("feature", { name: "Новая цель" }, "author");
      const application = await service.create(
        "application",
        { name: "Web", slug: "web" },
        "author",
      );
      const observed = await readVersionedEntity(db.commands, application.id, "application");

      const selected = await service.replaceParticipation(application.id, [feature.id], {
        actor: "editor",
        expectedVersion: observed.versions.aggregateVersion,
      });
      const input = { application: application.id, target: another.id, title: "Новый вклад" };
      await expectAsyncRelayError(
        () =>
          new KnowledgeService(db, { expectedVersion: observed.versions.aggregateVersion }).create(
            "implementation",
            input,
            "editor",
          ),
        "VERSION_CONFLICT",
      );
      const current = await readVersionedEntity(db.commands, application.id, "application");
      const created = await new KnowledgeService(db, {
        expectedVersion: current.versions.aggregateVersion,
      }).create("implementation", input, "editor");

      expect(selected.data.implementationIds).toHaveLength(1);
      expect(created).toMatchObject({
        key: "WEB-FI-2",
        data: { active: true, applicationId: application.id, targetId: another.id },
      });
      expect(service.get("application", application.id)).toMatchObject({
        revision: selected.revision + 1,
        data: { implementationIds: [...selected.data.implementationIds, created.id].sort() },
      });
    });
  });

  test("legacy product.create принимает constructor token пустого паспорта", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const observed = await readVersionedEntity(db.commands, "PRODUCT", "product");
      const facade = new KnowledgeService(db, {
        expectedVersion: observed.versions.aggregateVersion,
      });

      const created = await facade.create("product", { name: "Паспорт" }, "author");
      const generation = db.getGeneration();
      await expectAsyncRelayError(
        () => facade.create("product", { name: "Повтор" }, "author"),
        "VERSION_CONFLICT",
      );

      expect(created).toMatchObject({
        id: observed.entity.id,
        revision: observed.entity.revision + 1,
        data: { name: "Паспорт" },
      });
      expect(service.get("product")).toEqual(created);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(invalidRevisions)(
    "$name отклоняется до загрузки без подстановки числа",
    async ({ ifRevision, inherited }) => {
      await withKnowledgeFixture(async (service, db) => {
        const initial = await service.create("feature", { name: "Фича" }, "author");
        const observed = await readVersionedEntity(db.commands, initial.id, "feature");
        const expectedVersion = observed.versions.aggregateVersion;
        const facade = inherited ? new KnowledgeService(db, { expectedVersion }) : service;
        const generation = db.getGeneration();
        const load = spyOn(db.commands, "load");
        try {
          await expectAsyncRelayError(
            () =>
              facade.update(
                "feature",
                initial.id,
                { name: "Не записывать" },
                { actor: "editor", ifRevision, ...(inherited ? {} : { expectedVersion }) },
              ),
            "INVALID_ARGUMENT",
          );

          expect(load).not.toHaveBeenCalled();
          expect(service.get("feature", initial.id)).toEqual(initial);
          expect(db.getGeneration()).toBe(generation);
        } finally {
          load.mockRestore();
        }
      });
    },
  );

  test("актуальный token не подменяет явно переданный устаревший numeric CAS", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const initial = await service.create("feature", { name: "До" }, "author");
      const changed = await service.update(
        "feature",
        initial.id,
        { name: "После" },
        write(initial),
      );
      const observed = await readVersionedEntity(db.commands, initial.id, "feature");
      const generation = db.getGeneration();

      await expectAsyncRelayError(
        () =>
          service.update(
            "feature",
            initial.id,
            { name: "После" },
            {
              actor: "editor",
              ifRevision: initial.revision,
              expectedVersion: observed.versions.aggregateVersion,
            },
          ),
        "REVISION_CONFLICT",
      );

      expect(service.get("feature", initial.id)).toEqual(changed);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("без обоих условий сохраняется прежний отказ и неизвестные поля не принимаются", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const initial = await service.create("feature", { name: "Фича" }, "author");
      const observed = await readVersionedEntity(db.commands, initial.id, "feature");
      const invalidOptions = {
        actor: "editor",
        expectedVersion: observed.versions.aggregateVersion,
        unknown: true,
      };
      const generation = db.getGeneration();

      await expectAsyncRelayError(
        () => service.update("feature", initial.id, { name: "Не записывать" }, { actor: "editor" }),
        "INVALID_ARGUMENT",
      );
      await expectAsyncRelayError(
        () => service.update("feature", initial.id, { name: "Не записывать" }, invalidOptions),
        "INVALID_ARGUMENT",
      );

      expect(service.get("feature", initial.id)).toEqual(initial);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});
