import { describe, expect, spyOn, test } from "bun:test";
import type { EntityKind, EntityRecord, KnowledgeRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { entityWriteOptions as write, expectRelayError } from "./helpers/entity-fixture";
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
const corruptParticipation = ["missing", "foreign", "inactive", "omitted"] as const;
const participationWrites = ["create", "replace"] as const;
const damagedBacklinks = [
  { name: "null вместо ID владельца", value: null },
  { name: "посторонний ID владельца", value: "another-application" },
] as const;

/**
 * Создаёт только нужное знание и его обязательного владельца для проверки адресной мутации.
 */
function createTextRecord(
  service: KnowledgeService,
  kind: (typeof textKinds)[number],
): KnowledgeRecord {
  if (kind === "scenario") {
    const feature = service.create("feature", { name: "Фича" }, "tester");
    return service.create(kind, { name: "Исходное имя", feature: feature.id }, "tester");
  }
  if (kind === "document") {
    return service.create(
      kind,
      { name: "Исходное имя", body: "## Полное тело\n\nТекст." },
      "tester",
    );
  }
  if (kind === "application") {
    return service.create(kind, { name: "Исходное имя", slug: "client" }, "tester");
  }
  return service.create(kind, { name: "Исходное имя", description: "Полный текст" }, "tester");
}

describe("Адресная стоимость мутаций знаний", () => {
  test.each(addressMethods)(
    "%s с пустой ссылкой сохраняет диагностику ввода и данные",
    (method) => {
      withKnowledgeFixture((service, db) => {
        const feature = service.create("feature", { name: "Фича" }, "tester");
        const generation = db.getGeneration();

        expectRelayError(() => {
          if (method === "update") {
            return service.update("feature", "", { name: "Новое имя" }, write(feature));
          }
          return service.rename("feature", "", "CUSTOM", write(feature));
        }, "INVALID_ARGUMENT");

        expect(service.get("feature", feature.id)).toEqual(feature);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  for (const kind of textKinds) {
    test.each(mutationCases)(`${kind} update: $name читает владельца один раз`, ({ changed }) => {
      withKnowledgeFixture((service, db) => {
        const initial = createTextRecord(service, kind);
        const summary = changed ? "Новая аннотация" : "";
        const generation = db.getGeneration();
        const read = spyOn(db, "get");
        let result: KnowledgeRecord;
        try {
          result = service.update(kind, initial.id, { summary }, write(initial, "editor"));

          expect(read.mock.calls.filter(([ref]) => ref === initial.id)).toHaveLength(1);
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
    });

    test.each(mutationCases)(`${kind} rename: $name читает владельца один раз`, ({ changed }) => {
      withKnowledgeFixture((service, db) => {
        const initial = createTextRecord(service, kind);
        const generation = db.getGeneration();
        const read = spyOn(db, "get");
        const list = spyOn(db, "list");
        let result: KnowledgeRecord;
        try {
          result = service.rename(
            kind,
            initial.key,
            changed ? "CUSTOM" : initial.key,
            write(initial, "editor"),
          );

          expect(read.mock.calls.filter(([ref]) => ref === initial.id)).toHaveLength(1);
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
    });
  }

  test.each(mutationCases)(
    "имя приложения: $name читает приложение и доску по одному разу",
    ({ changed }) => {
      withKnowledgeFixture((service, db) => {
        const initial = service.create("application", { name: "Клиент", slug: "client" }, "tester");
        const board = service.get("board", initial.data.boardId);
        const renamedBoard = service.rename("board", board.id, "CUSTOM-BOARD", write(board));
        const name = changed ? "Новый клиент" : "Клиент";
        const generation = db.getGeneration();
        const read = spyOn(db, "get");
        try {
          const result = service.update("application", initial.id, { name }, write(initial));

          expect(read).toHaveBeenCalledTimes(2);
          expect(read.mock.calls.filter(([ref]) => ref === initial.id)).toHaveLength(1);
          expect(read.mock.calls.filter(([ref]) => ref === board.id)).toHaveLength(1);
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

  test("создание приложения и no-op доски обходятся без полных коллекций", () => {
    withKnowledgeFixture((service, db) => {
      service.create(
        "application",
        { name: "Существующее", slug: "existing", prefix: "APP-2" },
        "tester",
      );
      const list = spyOn(db, "list");
      try {
        const created = service.create("application", { name: "Новое", slug: "new-app" }, "tester");
        const board = service.get("board", created.data.boardId);
        const generation = db.getGeneration();
        const read = spyOn(db, "get");
        const addresses = spyOn(db, "findAddressIdentities");
        try {
          const unchanged = service.rename("board", board.key, board.key, write(board));

          expect(created.key).toBe("APP-3");
          expect(unchanged).toEqual(board);
          expect(read).toHaveBeenCalledTimes(1);
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
    (kind) => {
      withKnowledgeFixture((service, db) => {
        const initial = service.get(kind);
        const read = spyOn(db, "get");
        let renamed: KnowledgeRecord;
        try {
          renamed = service.rename(kind, undefined, "SINGLETON", write(initial));

          expect(read).toHaveBeenCalledTimes(1);
          expect(renamed).toMatchObject({
            id: initial.id,
            key: "SINGLETON",
            revision: initial.revision + 1,
          });
        } finally {
          read.mockRestore();
        }
        const generation = db.getGeneration();
        expectRelayError(
          () => service.rename(kind, undefined, "SINGLETON", write(initial)),
          "REVISION_CONFLICT",
        );
        expect(service.get(kind)).toEqual(renamed);
        expect(service.get(kind, initial.key)).toEqual(renamed);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("rename несинглтонного вида без ref отклоняется без записи", () => {
    withKnowledgeFixture((service, db) => {
      const initial = service.create("feature", { name: "Фича" }, "tester");
      const generation = db.getGeneration();

      expectRelayError(
        () => service.rename("feature", undefined, "CUSTOM", write(initial)),
        "INVALID_ARGUMENT",
      );

      expect(service.get("feature", initial.id)).toEqual(initial);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Предметная диагностика занятого адреса", () => {
  for (const kind of collisionKinds) {
    test.each(collisionForms)(`${kind}: чужой %s отклоняется с адресом и владельцем`, (form) => {
      withKnowledgeFixture((service, db) => {
        const initial =
          kind === "feature"
            ? service.create("feature", { name: "Фича" }, "tester")
            : service.get(kind);
        const owner = service.create(
          "document",
          { name: "Владелец адреса", body: "Текст" },
          "tester",
        );
        const renamed = service.rename("document", owner.id, "RESERVED", write(owner));
        const address = form === "alias" ? owner.key : renamed[form];
        const before = db.list();
        const generation = db.getGeneration();

        const error = expectRelayError(
          () => service.rename(kind, initial.id, address, write(initial)),
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
    });
  }
});

describe("Согласованное адресное участие приложения", () => {
  for (const operation of participationWrites) {
    test.each(damagedBacklinks)(
      `${operation}: $name отклоняется без изменения состава, счётчика и поколения`,
      ({ value }) => {
        withKnowledgeFixture((service, db) => {
          const { application, feature, scenario, featureImplementation } =
            createKnowledgeParticipation(service);
          // Повреждение введено через Storage: ID остаётся в составе, но обратная ссылка больше не выбирается.
          corruptKnowledgeRecord(db, featureImplementation, { applicationId: value });
          const before = db.list();
          const generation = db.getGeneration();

          expectRelayError(() => {
            if (operation === "create") {
              return service.create(
                "implementation",
                {
                  application: application.id,
                  target: feature.id,
                  title: "Не создавать замену повреждённой реализации",
                },
                "tester",
              );
            }
            return service.replaceParticipation(
              application.id,
              [feature.id, scenario.id],
              write(application),
            );
          }, "CORRUPT_DATA");

          expect(db.list()).toEqual(before);
          expect(db.getGeneration()).toBe(generation);
          // Резерв следующего ключа выполняется только после проверки отказа и удаляется вместе с fixture.
          expect(db.nextKey("WEB-FI")).toBe("WEB-FI-2");
        });
      },
    );
  }

  test("состав участия сохраняет порядок прежнего непостраничного каталога по ключу", () => {
    withKnowledgeFixture((service) => {
      const { application, featureImplementation, scenarioImplementation } =
        createKnowledgeParticipation(service);
      const first = service.rename(
        "implementation",
        featureImplementation.id,
        "a-first",
        write(featureImplementation),
      );
      const second = service.rename(
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

  test("замена читает только историю своего приложения и сохраняет снятую реализацию", () => {
    withKnowledgeFixture((service, db) => {
      const { application, feature, scenario, scenarioImplementation } =
        createKnowledgeParticipation(service);
      const removed = service.replaceParticipation(
        application.id,
        [feature.id],
        write(application),
      );
      const foreign = service.create(
        "application",
        { name: "Чужое приложение", slug: "foreign" },
        "tester",
      );
      const foreignImplementation = service.create(
        "implementation",
        { application: foreign.id, target: feature.id, title: "Чужой вклад" },
        "tester",
      );
      const list = spyOn(db, "list");
      const loadedIds: string[] = [];
      /**
       * Сохраняет настоящее адресное чтение для наблюдения загруженных ID.
       */
      const original: ProjectDatabase["listByField"] = db.listByField.bind(db);
      const selection = spyOn(db, "listByField").mockImplementation((kind, field, value) => {
        const records = original(kind, field, value);
        loadedIds.push(...records.map((record) => record.id));
        return records;
      });
      try {
        const restored = service.replaceParticipation(
          removed.id,
          [feature.id, scenario.id],
          write(removed),
        );

        expect(list).not.toHaveBeenCalled();
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

  test("участие по алиасу читает владельца один раз и выдаёт только активный состав", () => {
    withKnowledgeFixture((service, db) => {
      const { application, feature, featureImplementation } = createKnowledgeParticipation(service);
      const selected = service.replaceParticipation(
        application.id,
        [feature.id],
        write(application),
      );
      const renamed = service.rename("application", application.id, "CLIENT", write(selected));
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

  test("commit между чтением владельца и участием не смешивает снимки", () => {
    withKnowledgeFixture((service, db) => {
      const { application, feature, featureImplementation, scenarioImplementation } =
        createKnowledgeParticipation(service);
      const writer = ProjectDatabase.open(db.path);
      /**
       * Пропускает чтение в настоящий Storage перед синхронизированной конкурентной записью.
       */
      const original: (ref: string, kind?: EntityKind) => EntityRecord | undefined =
        db.get.bind(db);
      const intercepted = spyOn(db, "get").mockImplementation((ref, kind) => {
        const record = original(ref, kind);
        if (ref === application.id) {
          new KnowledgeService(writer).replaceParticipation(
            application.id,
            [feature.id],
            write(application),
          );
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

  test.each(corruptParticipation)("повреждённый состав %s даёт CORRUPT_DATA", (caseName) => {
    withKnowledgeFixture((service, db) => {
      const { application, feature, featureImplementation } = createKnowledgeParticipation(service);
      if (caseName === "inactive") {
        corruptKnowledgeRecord(db, featureImplementation, { active: false });
      } else {
        let ids = ["missing-id"];
        if (caseName === "foreign") {
          const foreign = service.create(
            "application",
            { name: "Чужое", slug: "foreign" },
            "tester",
          );
          const implementation = service.create(
            "implementation",
            { application: foreign.id, target: feature.id, title: "Чужой вклад" },
            "tester",
          );
          ids = [implementation.id];
        }
        if (caseName === "omitted") {
          ids = [];
        }
        corruptKnowledgeRecord(db, application, { implementationIds: ids });
      }
      const generation = db.getGeneration();

      expectRelayError(() => service.participation(application.id), "CORRUPT_DATA");

      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("фильтрованная страница досок сохраняет окончательный порядок SQLite", () => {
    withKnowledgeFixture((service) => {
      for (const [name, slug] of [
        ["Äther", "aether"],
        ["alpha", "alpha"],
        ["Zulu", "zulu"],
      ]) {
        service.create("application", { name, slug }, "tester");
      }

      const sort = spyOn(Array.prototype, "sort");
      try {
        const page = service.listPage("board", { q: "" }, { offset: 1, limit: 2, sort: "title" });
        const sortCount = sort.mock.calls.length;

        expect(sortCount).toBe(1);
        expect(page.total).toBe(4);
        expect(page.items.map((record) => record.data.name)).toEqual(["alpha", "Äther"]);
      } finally {
        sort.mockRestore();
      }
    });
  });
});
