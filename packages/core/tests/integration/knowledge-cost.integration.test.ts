import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { EntityKind, EntityRecord, KnowledgeRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { readVersionedEntity } from "../../src/commands/command-versioned-read";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { calculateParticipationReplacement } from "../../src/knowledge/knowledge-participation";
import {
  entityWriteOptions as write,
  expectRelayError,
  expectAsyncRelayError,
} from "./helpers/entity-fixture";
import {
  corruptKnowledgeRecord,
  createKnowledgeParticipation,
  withKnowledgeFixture,
} from "./helpers/knowledge-fixture";

const textKinds = ["feature", "scenario", "document", "application"] as const;
const mutationCases = [
  { name: "изменение", changed: true },
  { name: "no-op", changed: false },
] as const;
const singletonKinds = ["project", "product"] as const;
const collisionKinds = ["project", "product", "feature"] as const;
const collisionForms = ["key", "id", "alias"] as const;
const addressMethods = ["update", "rename"] as const;
const invalidParticipationTargets = [
  { name: "несуществующая реализация", target: "missing" },
  { name: "реализация чужого приложения", target: "foreign" },
] as const;
const participationOperations = ["create", "replace", "read"] as const;
const damagedBacklinks = [
  { name: "null вместо ID владельца", value: null, code: "CORRUPT_DATA" },
  { name: "несуществующий ID владельца", value: "another-application", code: "CONFLICT" },
] as const;

/**
 * Создаёт только нужное знание и его обязательного владельца для проверки адресной мутации.
 */
async function createTextRecord(
  service: KnowledgeService,
  kind: (typeof textKinds)[number],
): Promise<KnowledgeRecord> {
  if (kind === "scenario") {
    const feature = await service.create("feature", { name: "Фича" }, "tester");
    return await service.create(kind, { name: "Исходное имя", feature: feature.id }, "tester");
  }
  if (kind === "document") {
    return await service.create(
      kind,
      { name: "Исходное имя", body: "## Полное тело\n\nТекст." },
      "tester",
    );
  }
  if (kind === "application") {
    return await service.create(kind, { name: "Исходное имя", slug: "client" }, "tester");
  }
  return await service.create(
    kind,
    { name: "Исходное имя", description: "Полный текст" },
    "tester",
  );
}

/**
 * Повреждает только обратную ссылку реализации в изолированной файловой fixture.
 * FK отключаются на отдельном соединении, чтобы проверить диагностику адресного чтения,
 * а не штатный запрет записи. Проверяет выбор одной строки и всегда закрывает соединение.
 */
function corruptImplementationOwnerWithoutForeignKeys(
  path: string,
  implementationId: string,
): void {
  const raw = new Database(path, { create: false, readwrite: true, strict: true });
  try {
    raw.exec("PRAGMA foreign_keys = OFF");
    const result = raw
      .query<{ id: string }, [string, string]>(
        "UPDATE implementations SET application_id=? WHERE id=? RETURNING id",
      )
      .get("missing-application", implementationId);
    if (result?.id !== implementationId) {
      throw new Error("Подготовленная реализация не найдена для повреждения обратной ссылки");
    }
  } finally {
    raw.close();
  }
}

describe("Адресная стоимость мутаций знаний", () => {
  test.each(addressMethods)(
    "%s с пустой ссылкой сохраняет диагностику ввода и данные",
    async (method) => {
      await withKnowledgeFixture(async (service, db) => {
        const feature = await service.create("feature", { name: "Фича" }, "tester");
        const generation = db.getGeneration();

        await expectAsyncRelayError(async () => {
          if (method === "update") {
            return await service.update("feature", "", { name: "Новое имя" }, write(feature));
          }
          return await service.rename("feature", "", "CUSTOM", write(feature));
        }, "INVALID_ARGUMENT");

        expect(service.get("feature", feature.id)).toEqual(feature);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  for (const kind of textKinds) {
    test.each(mutationCases)(
      `${kind} update: $name читает владельца один раз`,
      async ({ changed }) => {
        await withKnowledgeFixture(async (service, db) => {
          const initial = await createTextRecord(service, kind);
          const summary = changed ? "Новая аннотация" : "";
          const generation = db.getGeneration();
          const read = spyOn(db.commands, "load");
          let result: KnowledgeRecord;
          try {
            result = await service.update(kind, initial.id, { summary }, write(initial, "editor"));

            const selectors = read.mock.calls.flatMap(([request]) => request.selectors);
            expect(
              selectors.filter(
                (selector) => selector.kind === "entity" && selector.ref === initial.id,
              ),
            ).toHaveLength(1);
            expect(selectors.some((selector) => selector.kind === "kind")).toBe(false);
            expect(result).toMatchObject({
              id: initial.id,
              revision: initial.revision + Number(changed),
              data: { ...initial.data, summary },
              updatedBy: changed ? "editor" : initial.updatedBy,
            });
            expect(db.getGeneration()).toBe(generation + Number(changed));
          } finally {
            read.mockRestore();
          }
          expect(service.get(kind, initial.id)).toEqual(result);
        });
      },
    );

    test.each(mutationCases)(
      `${kind} rename: $name читает владельца один раз`,
      async ({ changed }) => {
        await withKnowledgeFixture(async (service, db) => {
          const initial = await createTextRecord(service, kind);
          const generation = db.getGeneration();
          const read = spyOn(db.commands, "load");
          const list = spyOn(db, "list");
          let result: KnowledgeRecord;
          try {
            result = await service.rename(
              kind,
              initial.key,
              changed ? "CUSTOM" : initial.key,
              write(initial, "editor"),
            );

            const selectors = read.mock.calls.flatMap(([request]) => request.selectors);
            expect(
              selectors.filter(
                (selector) => selector.kind === "entity" && selector.ref === initial.id,
              ),
            ).toHaveLength(1);
            expect(selectors.some((selector) => selector.kind === "kind")).toBe(false);
            expect(list).not.toHaveBeenCalled();
            expect(result).toMatchObject({
              id: initial.id,
              key: changed ? "CUSTOM" : initial.key,
              revision: initial.revision + Number(changed),
              data: initial.data,
            });
            expect(db.getGeneration()).toBe(generation + Number(changed));
          } finally {
            read.mockRestore();
            list.mockRestore();
          }
          expect(service.get(kind, initial.key)).toEqual(result);
          expect(service.get(kind, result.key)).toEqual(result);
        });
      },
    );
  }

  test.each(mutationCases)(
    "имя приложения: $name читает приложение и доску по одному разу",
    async ({ changed }) => {
      await withKnowledgeFixture(async (service, db) => {
        const initial = await service.create(
          "application",
          { name: "Клиент", slug: "client" },
          "tester",
        );
        const board = service.get("board", initial.data.boardId);
        const renamedBoard = await service.rename("board", board.id, "CUSTOM-BOARD", write(board));
        const name = changed ? "Новый клиент" : "Клиент";
        const generation = db.getGeneration();
        const read = spyOn(db.commands, "load");
        try {
          const result = await service.update("application", initial.id, { name }, write(initial));

          const records = read.mock.calls
            .flatMap(([request]) => request.selectors)
            .filter((selector) => selector.kind === "entity");
          expect(records).toHaveLength(2);
          expect(records.filter((selector) => selector.ref === initial.id)).toHaveLength(1);
          expect(records.filter((selector) => selector.ref === board.id)).toHaveLength(1);
          expect(result.data.name).toBe(name);
          expect(result.revision).toBe(initial.revision + Number(changed));
        } finally {
          read.mockRestore();
        }
        expect(service.get("board", board.id)).toMatchObject({
          key: "CUSTOM-BOARD",
          revision: renamedBoard.revision + Number(changed),
          data: { ...renamedBoard.data, name },
        });
        expect(db.getGeneration()).toBe(generation + 2 * Number(changed));
      });
    },
  );

  test("создание приложения и no-op доски обходятся без полных коллекций", async () => {
    await withKnowledgeFixture(async (service, db) => {
      await service.create(
        "application",
        { name: "Существующее", slug: "existing", prefix: "APP-2" },
        "tester",
      );
      const list = spyOn(db, "list");
      try {
        const created = await service.create(
          "application",
          { name: "Новое", slug: "new-app" },
          "tester",
        );
        const board = service.get("board", created.data.boardId);
        const generation = db.getGeneration();
        const read = spyOn(db.commands, "load");
        const addresses = spyOn(db, "findAddressIdentities");
        try {
          const unchanged = await service.rename("board", board.key, board.key, write(board));

          expect(created.key).toBe("APP-3");
          expect(unchanged).toEqual(board);
          const selectors = read.mock.calls.flatMap(([request]) => request.selectors);
          expect(selectors.filter((selector) => selector.kind === "entity")).toHaveLength(1);
          expect(
            selectors.some((selector) => selector.kind === "virtual" || selector.kind === "kind"),
          ).toBe(false);
          expect(addresses).not.toHaveBeenCalled();
          expect(db.getGeneration()).toBe(generation);
        } finally {
          read.mockRestore();
          addresses.mockRestore();
        }
        expect(list).not.toHaveBeenCalled();
      } finally {
        list.mockRestore();
      }
    });
  });

  test.each(singletonKinds)(
    "rename %s без ref сохраняет singleton, алиас и CAS до no-op",
    async (kind) => {
      await withKnowledgeFixture(async (service, db) => {
        const initial = service.get(kind);
        const read = spyOn(db.commands, "load");
        let renamed: KnowledgeRecord;
        try {
          renamed = await service.rename(kind, undefined, "SINGLETON", write(initial));

          expect(
            read.mock.calls
              .flatMap(([request]) => request.selectors)
              .filter((selector) => selector.kind === "entity"),
          ).toHaveLength(1);
          expect(renamed).toMatchObject({
            id: initial.id,
            key: "SINGLETON",
            revision: initial.revision + 1,
          });
        } finally {
          read.mockRestore();
        }
        const generation = db.getGeneration();
        await expectAsyncRelayError(
          async () => await service.rename(kind, undefined, "SINGLETON", write(initial)),
          "REVISION_CONFLICT",
        );
        expect(service.get(kind)).toEqual(renamed);
        expect(service.get(kind, initial.key)).toEqual(renamed);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("rename несинглтонного вида без ref отклоняется без записи", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const initial = await service.create("feature", { name: "Фича" }, "tester");
      const generation = db.getGeneration();

      await expectAsyncRelayError(
        async () => await service.rename("feature", undefined, "CUSTOM", write(initial)),
        "INVALID_ARGUMENT",
      );

      expect(service.get("feature", initial.id)).toEqual(initial);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Предметная диагностика занятого адреса", () => {
  for (const kind of collisionKinds) {
    test.each(collisionForms)(
      `${kind}: чужой %s отклоняется с адресом и владельцем`,
      async (form) => {
        await withKnowledgeFixture(async (service, db) => {
          const initial =
            kind === "feature"
              ? await service.create("feature", { name: "Фича" }, "tester")
              : service.get(kind);
          const owner = await service.create(
            "document",
            { name: "Владелец адреса", body: "Текст" },
            "tester",
          );
          const renamed = await service.rename("document", owner.id, "RESERVED", write(owner));
          const address = form === "alias" ? owner.key : renamed[form];
          const before = db.list();
          const generation = db.getGeneration();

          const error = await expectAsyncRelayError(
            async () => await service.rename(kind, initial.id, address, write(initial)),
            "CONFLICT",
          );

          expect(error.message).toContain(address);
          expect(error.details).toMatchObject({
            ref: address,
            owner: { id: owner.id, kind: "document", key: "RESERVED" },
          });
          expect(db.list()).toEqual(before);
          expect(db.getGeneration()).toBe(generation);
          expect(service.get("document", address)).toEqual(renamed);
        });
      },
    );
  }
});

describe("Согласованное адресное участие приложения", () => {
  test.each(damagedBacklinks)(
    "$name отклоняется при записи без изменения состава, счётчика и поколения",
    async ({ value, code }) => {
      await withKnowledgeFixture(async (service, db) => {
        const { application, featureImplementation, scenarioImplementation } =
          await createKnowledgeParticipation(service);
        const before = db.list();
        const parts = db.getComponents([application.id]);
        const generation = db.getGeneration();
        const pending = db.getReplicationOutbox();

        expectRelayError(
          () => corruptKnowledgeRecord(db, featureImplementation, { applicationId: value }),
          code,
        );

        expect(db.list()).toEqual(before);
        expect(db.getComponents([application.id])).toEqual(parts);
        expect(db.getGeneration()).toBe(generation);
        expect(db.getReplicationOutbox()).toEqual(pending);
        expect(service.participation(application.id)).toEqual({
          application: application.key,
          revision: application.revision,
          items: [featureImplementation, scenarioImplementation],
        });
        // Резерв проверяет сохранность счётчика после отказа и удаляется вместе с fixture.
        expect(db.nextKey("WEB-FI")).toBe("WEB-FI-2");
      });
    },
  );

  test.each(participationOperations)(
    "%s не скрывает повреждённую SQL-обратную ссылку при адресной выборке участия",
    async (operation) => {
      await withKnowledgeFixture(async (service, db) => {
        const { application, feature, scenario, featureImplementation } =
          await createKnowledgeParticipation(service);
        corruptImplementationOwnerWithoutForeignKeys(db.path, featureImplementation.id);
        const before = db.list();
        const parts = db.getComponents([application.id]);
        const generation = db.getGeneration();
        const pending = db.getReplicationOutbox();
        const load = spyOn(db.commands, "load");
        const read = spyOn(db, "get");
        const selection = spyOn(db, "listByField");
        const list = spyOn(db, "list");
        try {
          const failure = await expectAsyncRelayError(async () => {
            if (operation === "create") {
              return await service.create(
                "implementation",
                {
                  application: application.id,
                  target: feature.id,
                  title: "Не создавать замену повреждённой реализации",
                },
                "tester",
              );
            }
            if (operation === "read") {
              return service.participation(application.id);
            }
            return await service.replaceParticipation(
              application.id,
              [feature.id, scenario.id],
              write(application),
            );
          }, "CORRUPT_DATA");

          expect(failure.details).toMatchObject({ id: application.id });
          expect(list).not.toHaveBeenCalled();
          if (operation === "read") {
            expect(read).toHaveBeenCalledTimes(1);
            expect(selection.mock.calls).toEqual([
              ["implementation", "applicationId", application.id],
            ]);
          } else {
            const selectors = load.mock.calls.flatMap(([request]) => request.selectors);
            expect(selectors.filter((selector) => selector.kind === "field")).toEqual([
              {
                kind: "field",
                entityKind: "implementation",
                field: "applicationId",
                value: application.id,
              },
            ]);
            expect(selectors.some((selector) => selector.kind === "kind")).toBe(false);
          }
        } finally {
          load.mockRestore();
          read.mockRestore();
          selection.mockRestore();
          list.mockRestore();
        }
        expect(db.list()).toEqual(before);
        expect(db.getComponents([application.id])).toEqual(parts);
        expect(db.getGeneration()).toBe(generation);
        expect(db.getReplicationOutbox()).toEqual(pending);
        expect(db.nextKey("WEB-FI")).toBe("WEB-FI-2");
      });
    },
  );

  test("состав участия сохраняет порядок прежнего непостраничного каталога по ключу", async () => {
    await withKnowledgeFixture(async (service) => {
      const { application, featureImplementation, scenarioImplementation } =
        await createKnowledgeParticipation(service);
      const first = await service.rename(
        "implementation",
        featureImplementation.id,
        "a-first",
        write(featureImplementation),
      );
      const second = await service.rename(
        "implementation",
        scenarioImplementation.id,
        "Z-second",
        write(scenarioImplementation),
      );

      const result = service.participation(application.id);

      expect(result).toEqual({
        application: application.key,
        revision: application.revision,
        items: [first, second],
      });
    });
  });

  test("замена читает только историю своего приложения и сохраняет снятую реализацию", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const { application, feature, scenario, scenarioImplementation } =
        await createKnowledgeParticipation(service);
      const removed = await service.replaceParticipation(
        application.id,
        [feature.id],
        write(application),
      );
      const foreign = await service.create(
        "application",
        { name: "Чужое приложение", slug: "foreign" },
        "tester",
      );
      const foreignImplementation = await service.create(
        "implementation",
        { application: foreign.id, target: feature.id, title: "Чужой вклад" },
        "tester",
      );
      const list = spyOn(db, "list");
      const loadedIds: string[] = [];
      /**
       * Выполняет настоящую async загрузку и наблюдает только возвращённые карточки.
       */
      const load = db.commands.load.bind(db.commands);
      const selection = spyOn(db.commands, "load").mockImplementation(async (request) => {
        const result = await load(request);
        for (const observation of result.observations) {
          if (observation.kind === "records") {
            loadedIds.push(...observation.records.map((record) => record.id));
          }
        }
        return result;
      });
      try {
        const restored = await service.replaceParticipation(
          removed.id,
          [feature.id, scenario.id],
          write(removed),
        );

        expect(list).not.toHaveBeenCalled();
        const selectors = selection.mock.calls.flatMap(([request]) => request.selectors);
        expect(selectors.filter((selector) => selector.kind === "field")).toEqual([
          {
            kind: "field",
            entityKind: "implementation",
            field: "applicationId",
            value: application.id,
          },
        ]);
        expect(selectors.some((selector) => selector.kind === "kind")).toBe(false);
        expect(loadedIds).toContain(scenarioImplementation.id);
        expect(loadedIds).not.toContain(foreignImplementation.id);
        expect(restored.data.implementationIds).toContain(scenarioImplementation.id);
        expect(service.get("implementation", scenarioImplementation.id)).toMatchObject({
          key: scenarioImplementation.key,
          data: scenarioImplementation.data,
          revision: scenarioImplementation.revision + 2,
        });
        expect(service.get("implementation", foreignImplementation.id)).toEqual(
          foreignImplementation,
        );
      } finally {
        list.mockRestore();
        selection.mockRestore();
      }
    });
  });

  test("участие по алиасу читает владельца один раз и выдаёт только активный состав", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const { application, feature, featureImplementation } =
        await createKnowledgeParticipation(service);
      const selected = await service.replaceParticipation(
        application.id,
        [feature.id],
        write(application),
      );
      const renamed = await service.rename(
        "application",
        application.id,
        "CLIENT",
        write(selected),
      );
      const read = spyOn(db, "get");
      const list = spyOn(db, "list");
      try {
        const result = service.participation(`application:${application.key}`);

        expect(result).toEqual({
          application: "CLIENT",
          revision: renamed.revision,
          items: [featureImplementation],
        });
        expect(read).toHaveBeenCalledTimes(1);
        expect(list).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
        list.mockRestore();
      }
    });
  });

  test("commit между чтением владельца и участием не смешивает снимки", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const { application, feature, featureImplementation, scenarioImplementation } =
        await createKnowledgeParticipation(service);
      const writer = ProjectDatabase.open(db.path);
      const replacement = calculateParticipationReplacement(
        { application, existing: [featureImplementation, scenarioImplementation] },
        [{ reference: feature, target: null, allocation: null }],
        write(application),
        new Date().toISOString(),
      );
      /**
       * Пропускает чтение в настоящий Storage перед синхронизированной конкурентной записью.
       */
      const original: (ref: string, kind?: EntityKind) => EntityRecord | undefined =
        db.get.bind(db);
      const intercepted = spyOn(db, "get").mockImplementation((ref, kind) => {
        const record = original(ref, kind);
        if (ref === application.id) {
          // Расчёт завершён до sync чтения; конкурентный commit содержит только его точные эффекты.
          writer.transaction(() => {
            for (const effect of replacement.effects) {
              if (effect.kind === "entity" && effect.before !== null) {
                writer.update(effect.after, effect.before.revision);
              }
            }
          });
        }
        return record;
      });
      try {
        const result = service.participation(application.id);

        expect(result).toEqual({
          application: application.key,
          revision: application.revision,
          items: [featureImplementation, scenarioImplementation],
        });
      } finally {
        intercepted.mockRestore();
        writer.close();
      }
      expect(service.participation(application.id)).toEqual({
        application: application.key,
        revision: application.revision + 1,
        items: [featureImplementation],
      });
    });
  });

  test.each(invalidParticipationTargets)(
    "$name отклоняется при записи состава",
    async ({ target }) => {
      await withKnowledgeFixture(async (service, db) => {
        const { application, feature, featureImplementation, scenarioImplementation } =
          await createKnowledgeParticipation(service);
        let id = "missing-id";
        if (target === "foreign") {
          const foreign = await service.create(
            "application",
            { name: "Чужое", slug: "foreign" },
            "tester",
          );
          const implementation = await service.create(
            "implementation",
            { application: foreign.id, target: feature.id, title: "Чужой вклад" },
            "tester",
          );
          id = implementation.id;
        }
        const before = db.list();
        const parts = db.getComponents([application.id]);
        const generation = db.getGeneration();
        const pending = db.getReplicationOutbox();

        const failure = expectRelayError(
          () => corruptKnowledgeRecord(db, application, { implementationIds: [id] }),
          "CONFLICT",
        );

        expect(failure.details).toMatchObject({ reason: "FOREIGN KEY constraint failed" });
        expect(db.list()).toEqual(before);
        expect(db.getComponents([application.id])).toEqual(parts);
        expect(db.getGeneration()).toBe(generation);
        expect(db.getReplicationOutbox()).toEqual(pending);
        expect(service.participation(application.id)).toEqual({
          application: application.key,
          revision: application.revision,
          items: [featureImplementation, scenarioImplementation],
        });
      });
    },
  );

  test("правка текста и статуса реализации сохраняет активное участие и согласованные версии", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const { application, featureImplementation, scenarioImplementation } =
        await createKnowledgeParticipation(service);
      const observed = await readVersionedEntity(
        db.commands,
        featureImplementation.id,
        "implementation",
      );
      const parts = db.getComponents([application.id]);
      const generation = db.getGeneration();

      const updated = await service.update(
        "implementation",
        featureImplementation.id,
        { description: "Уточнённый вклад", status: "partial" },
        {
          ...write(featureImplementation, "editor"),
          expectedVersion: observed.versions.aggregateVersion,
        },
      );

      expect(updated).toMatchObject({
        id: featureImplementation.id,
        key: featureImplementation.key,
        revision: featureImplementation.revision + 1,
        createdAt: featureImplementation.createdAt,
        createdBy: featureImplementation.createdBy,
        updatedBy: "editor",
        data: {
          ...featureImplementation.data,
          description: "Уточнённый вклад",
          status: "partial",
          active: true,
        },
      });
      expect(service.get("implementation", featureImplementation.id)).toEqual(updated);
      expect(service.get("application", application.id)).toEqual(application);
      expect(db.getComponents([application.id])).toEqual(parts);
      expect(db.getGeneration()).toBe(generation + 1);
      expect(service.participation(application.id)).toEqual({
        application: application.key,
        revision: application.revision,
        items: [updated, scenarioImplementation],
      });

      const captured = db.captureReplication();
      const current = await readVersionedEntity(db.commands, updated.id, "implementation");
      expect(current.entity).toEqual(updated);
      expect(current.versions.recordVersion).not.toBe(observed.versions.recordVersion);
      expect(captured.entities.find((entry) => entry.record.id === updated.id)).toMatchObject({
        version: current.versions.recordVersion,
        record: { data: updated.data },
      });
    });
  });

  test("замена участия снимает реализации и сохраняет согласованные переносимые версии", async () => {
    await withKnowledgeFixture(async (service, db) => {
      const { application, featureImplementation, scenarioImplementation } =
        await createKnowledgeParticipation(service);
      const observed = await readVersionedEntity(db.commands, application.id, "application");
      const generation = db.getGeneration();

      const removed = await service.replaceParticipation(application.id, [], {
        ...write(application, "editor"),
        expectedVersion: observed.versions.aggregateVersion,
      });

      expect(removed).toMatchObject({
        id: application.id,
        revision: application.revision + 1,
        data: { ...application.data, implementationIds: [] },
      });
      expect(service.get("application", application.id)).toEqual(removed);
      expect(service.participation(application.id)).toEqual({
        application: application.key,
        revision: removed.revision,
        items: [],
      });
      expect(db.getGeneration()).toBe(generation + 3);

      const captured = db.captureReplication();
      const currentApplication = await readVersionedEntity(
        db.commands,
        application.id,
        "application",
      );
      expect(currentApplication.entity).toEqual(removed);
      expect(currentApplication.versions.aggregateVersion).not.toBe(
        observed.versions.aggregateVersion,
      );
      expect(captured.entities.find((entry) => entry.record.id === application.id)?.version).toBe(
        currentApplication.versions.recordVersion,
      );
      const memberships = captured.components?.filter(
        (part) => part.ownerId === application.id && part.kind === "application-participation",
      );
      expect(memberships).toHaveLength(2);
      expect(memberships?.every((part) => part.deleted)).toBe(true);
      for (const implementation of [featureImplementation, scenarioImplementation]) {
        const current = await readVersionedEntity(db.commands, implementation.id, "implementation");
        expect(current.entity).toMatchObject({
          id: implementation.id,
          key: implementation.key,
          revision: implementation.revision + 1,
          updatedBy: "editor",
          data: { ...implementation.data, active: false },
        });
        expect(current.entity).toEqual(service.get("implementation", implementation.id));
        expect(
          captured.entities.find((entry) => entry.record.id === implementation.id),
        ).toMatchObject({
          version: current.versions.recordVersion,
          record: { data: current.entity.data },
        });
      }

      const reopened = ProjectDatabase.open(db.path);
      try {
        expect(reopened.captureReplication()).toEqual(captured);
        expect(new KnowledgeService(reopened).participation(application.id)).toEqual({
          application: application.key,
          revision: removed.revision,
          items: [],
        });
      } finally {
        reopened.close();
      }
    });
  });

  test("фильтрованная страница досок сохраняет окончательный порядок SQLite", async () => {
    await withKnowledgeFixture(async (service) => {
      for (const [name, slug] of [
        ["Äther", "aether"],
        ["alpha", "alpha"],
        ["Zulu", "zulu"],
      ]) {
        await service.create("application", { name, slug }, "tester");
      }

      const sort = spyOn(Array.prototype, "sort");
      try {
        const page = service.listPage("board", { q: "" }, { offset: 1, limit: 2, sort: "title" });
        // Технические канонизации JSON в Storage не являются сортировкой предметного каталога.
        const sortCount = sort.mock.contexts.filter(
          (items: unknown) =>
            Array.isArray(items) &&
            items.some(
              (item: unknown) =>
                item !== null &&
                typeof item === "object" &&
                (("kind" in item && item.kind === "board") ||
                  ("record" in item &&
                    item.record !== null &&
                    typeof item.record === "object" &&
                    "kind" in item.record &&
                    item.record.kind === "board")),
            ),
        ).length;

        expect(sortCount).toBe(1);
        expect(page.total).toBe(4);
        expect(page.items.map((record) => record.data.name)).toEqual(["alpha", "Äther"]);
      } finally {
        sort.mockRestore();
      }
    });
  });
});
