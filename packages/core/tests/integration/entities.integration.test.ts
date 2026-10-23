import { describe, expect, test } from "bun:test";
import { RelayError, type EntityRecord, type WriteOptions } from "@relay/contracts";
import { EntityService } from "../../src/entities/entities";
import * as publicCore from "../../src/index";
import { entityWriteOptions, expectRelayError, withEntityDatabase } from "./helpers/entity-fixture";

const referenceForms = [
  { name: "ID", field: "id" },
  { name: "прежний ключ", field: "alias" },
  { name: "текущий ключ", field: "key" },
] as const;
const invalidReferences = [
  { name: "неизвестный вид", ref: "unknown:GUIDE" },
  { name: "пустой адрес", ref: "document:" },
  { name: "вложенный вид", ref: "document:task:GUIDE" },
] as const;
const invalidJsonValues = [
  { name: "undefined", value: undefined },
  { name: "NaN", value: NaN },
  { name: "Infinity", value: Infinity },
  { name: "bigint", value: 1n },
  { name: "функция", value: invalidJsonFunction },
  { name: "Date", value: new Date("2026-01-01T00:00:00Z") },
  { name: "Map", value: new Map() },
] as const;
const invalidArrays = [
  { name: "пропуск в начале", shape: "head" },
  { name: "пропуск в конце", shape: "tail" },
  { name: "undefined в элементе", shape: "undefined" },
  { name: "вложенный разреженный массив", shape: "nested" },
] as const;
const invalidRevisions = [
  { name: "ноль", revision: 0 },
  { name: "отрицательное число", revision: -1 },
  { name: "дробное число", revision: 1.5 },
  { name: "NaN", revision: NaN },
  { name: "небезопасное целое", revision: Number.MAX_SAFE_INTEGER + 1 },
] as const;
const revisionOperations = ["update", "rename"] as const;
const jsonWriteOperations = ["create", "update"] as const;
const commentSnapshots = [
  {
    name: "только с прежними комментариями",
    patch: { comments: [] },
    revision: 1,
    generationDelta: 0,
  },
  {
    name: "с новым заголовком",
    patch: { title: "Уточнение", comments: [] },
    revision: 2,
    generationDelta: 1,
  },
] as const;
const aliasForms = [
  { name: "нетипизированный", typed: false },
  { name: "типизированный", typed: true },
] as const;
const mismatchedKinds = [
  { name: "нетипизированного адреса", typed: false, code: "NOT_FOUND" },
  { name: "типизированного адреса", typed: true, code: "INVALID_ARGUMENT" },
] as const;
const invalidAddressOperations = ["ключ", "префикс", "переименование", "Storage"] as const;
const invalidIdentityInputs = [
  { name: "пустой автор", actor: " ", key: "DOC-1", code: "INVALID_ARGUMENT" },
  { name: "ключ с пробелом", actor: "author", key: "BAD KEY", code: "VALIDATION_ERROR" },
] as const;
const nestedChanges = [
  { name: "no-op", patch: {} },
  { name: "изменение", patch: { title: "Из устаревшего снимка" } },
] as const;
const absentRevisionInputs = [
  { name: "пропущенная ревизия", value: undefined },
  { name: "строка вместо ревизии", value: "current" },
] as const;

/**
 * Представляет намеренно недопустимое JSON-значение; тест не вызывает эту функцию.
 */
function invalidJsonFunction(): void {}

/**
 * Создаёт новый повреждённый массив для каждого случая проверки JSON-границы.
 */
function createInvalidArray(shape: "head" | "tail" | "undefined" | "nested"): unknown {
  if (shape === "undefined") {
    return [undefined];
  }
  if (shape === "tail") {
    const tail: unknown[] = ["Первое значение"];
    tail.length = 2;
    return tail;
  }
  const sparse: unknown[] = [];
  sparse[2] = "Последнее значение";
  if (shape === "nested") {
    return { nested: [sparse] };
  }
  return sparse;
}

/**
 * Выбирает адрес подготовленной записи; alias берётся из снимка до переименования.
 */
function entityReference(
  initial: EntityRecord,
  current: EntityRecord,
  field: "id" | "alias" | "key",
): string {
  if (field === "alias") {
    return initial.key;
  }
  return current[field];
}

describe("Границы общего механизма сущностей Core", () => {
  test("публичный API исключает универсальную мутацию в обход предметных сервисов", () => {
    expect(Object.hasOwn(publicCore, "EntityService")).toBe(false);
  });

  test("изменение входного объекта после create не меняет сохранённый payload", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const input = { title: "Документ", nested: { enabled: true } };

      const created = entities.create("document", "DOC", input, "author");
      input.nested.enabled = false;

      expect(created.key).toBe("DOC-1");
      expect(entities.get(created.id).data).toEqual({
        title: "Документ",
        nested: { enabled: true },
      });
    });
  });

  test("частичное обновление сохраняет идентичность, автора создания и остальные поля", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const created = entities.create(
        "document",
        "DOC",
        { title: "Документ", nested: { enabled: true } },
        "author",
      );

      const updated = entities.update(
        created.key,
        "document",
        { title: "Новый заголовок" },
        entityWriteOptions(created, "editor"),
      );

      expect(updated).toMatchObject({
        id: created.id,
        key: created.key,
        revision: created.revision + 1,
        createdBy: "author",
        createdAt: created.createdAt,
        updatedBy: "editor",
        data: { title: "Новый заголовок", nested: { enabled: true } },
      });
      expect(entities.get(created.id)).toEqual(updated);
    });
  });

  test.each(revisionOperations)(
    "%s без изменения содержания сохраняет ревизию, дату, автора и поколение",
    (operation) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const initial = entities.create("document", "DOC", { title: "Текст" }, "author");
        const current = entities.update(
          initial.id,
          "document",
          { title: "Новый текст" },
          entityWriteOptions(initial, "editor"),
        );
        const generation = db.getGeneration();

        const result =
          operation === "update"
            ? entities.update(
                current.id,
                "document",
                { title: "Новый текст" },
                entityWriteOptions(current, "other"),
              )
            : entities.rename(
                current.id,
                "document",
                current.key,
                entityWriteOptions(current, "other"),
              );

        expect(result).toEqual(current);
        expect(entities.get(current.id)).toEqual(current);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test.each(revisionOperations)(
    "%s с устаревшей ревизией отклоняет даже no-op без изменения записи",
    (operation) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const initial = entities.create("document", "DOC", { title: "Текст" }, "author");
        const current = entities.update(
          initial.id,
          "document",
          { title: "Новый текст" },
          entityWriteOptions(initial),
        );
        const generation = db.getGeneration();

        expectRelayError(() => {
          if (operation === "update") {
            return entities.update(
              initial.id,
              "document",
              { title: "Новый текст" },
              entityWriteOptions(initial),
            );
          }
          return entities.rename(initial.id, "document", current.key, entityWriteOptions(initial));
        }, "REVISION_CONFLICT");

        expect(entities.get(initial.id)).toEqual(current);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("поздний отказ составной записи откатывает сущности, поколение и счётчик ключей", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          db.transaction(() => {
            entities.create("document", "DOC", {}, "author");
            entities.create("document", "DOC", {}, "author");
            throw new RelayError("INVALID_LINK", "Несуществующая ссылка", 2);
          }),
        "INVALID_LINK",
      );

      expect(entities.list("document")).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
      expect(entities.create("document", "DOC", {}, "author").key).toBe("DOC-1");
    });
  });

  test.each(nestedChanges)(
    "подготовка после вложенной записи: $name отвергает устаревшую карточку",
    ({ patch }) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const initial = entities.create("document", "DOC", { title: "До изменения" }, "author");
        const generation = db.getGeneration();

        expectRelayError(
          () =>
            entities.change(initial.id, "document", entityWriteOptions(initial), (current) => {
              entities.rename(current.id, "document", "NESTED-KEY", entityWriteOptions(current));
              return { patch };
            }),
          "REVISION_CONFLICT",
        );

        expect(entities.get(initial.id)).toEqual(initial);
        expect(db.getIdentity("NESTED-KEY")).toBeUndefined();
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("подготовка получает копию и не может превратить реальное изменение в ложный no-op", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const initial = entities.create("document", "DOC", { title: "До изменения" }, "author");

      const updated = entities.change(
        initial.id,
        "document",
        entityWriteOptions(initial),
        (current) => {
          current.data.title = "После изменения";
          return { patch: current.data };
        },
      );

      expect(updated.data.title).toBe("После изменения");
      expect(updated.revision).toBe(initial.revision + 1);
      expect(entities.get(initial.id)).toEqual(updated);
    });
  });

  test.each(absentRevisionInputs)(
    "$name не подменяется текущей при подготовке no-op",
    ({ value }) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const initial = entities.create("document", "DOC", {}, "author");
        const generation = db.getGeneration();
        // Намеренно неверный транспортный тип проверяет runtime-границу примитива записи.
        const invalidWrite = { actor: "author", ifRevision: value } as unknown as WriteOptions;

        expectRelayError(
          () => entities.change(initial.id, "document", invalidWrite, () => ({ patch: {} })),
          "VALIDATION_ERROR",
        );

        expect(entities.get(initial.id)).toEqual(initial);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );
});

describe("Независимый журнал комментариев задачи", () => {
  test("комментарий, добавленный во время подготовки no-op, возвращается без потери журнала", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const task = entities.create("task", "TASK", { title: "Задача" }, "author");
      const comment = {
        id: crypto.randomUUID(),
        title: "",
        body: "Новое обсуждение",
        createdAt: new Date().toISOString(),
        createdBy: "reviewer",
      };
      const generation = db.getGeneration();

      const unchanged = entities.change(task.id, "task", entityWriteOptions(task), (current) => {
        db.appendTaskComment(current.id, comment);
        return { patch: { comments: [] } };
      });

      expect(unchanged.revision).toBe(task.revision);
      expect(unchanged.data.comments).toEqual([comment]);
      expect(entities.get(task.id)).toEqual(unchanged);
      expect(db.getGeneration()).toBe(generation + 1);
    });
  });

  test("создание задачи возвращает ту же пустую проекцию журнала, что get", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);

      const created = entities.create("task", "TASK", { title: "Задача" }, "author");

      expect(created.data.comments).toEqual([]);
      expect(entities.get(created.id)).toEqual(created);
    });
  });

  test.each(commentSnapshots)(
    "запись старого снимка $name сохраняет добавленный комментарий",
    ({ patch, revision, generationDelta }) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const created = entities.create("task", "TASK", { title: "Задача" }, "author");
        const entry = {
          id: crypto.randomUUID(),
          title: "",
          body: "Обсуждение",
          createdAt: new Date().toISOString(),
          createdBy: "reviewer",
        };
        db.appendTaskComment(created.id, entry);
        const generation = db.getGeneration();

        const updated = entities.update(
          created.id,
          "task",
          structuredClone(patch),
          entityWriteOptions(created),
        );

        expect(updated.revision).toBe(revision);
        expect(updated.data.comments).toEqual([entry]);
        expect(entities.get(created.id)).toEqual(updated);
        expect(db.getGeneration()).toBe(generation + generationDelta);
      });
    },
  );

  test("устаревший no-op комментариев отклоняется без изменения содержания и журнала", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const initial = entities.create("task", "TASK", { title: "Задача" }, "author");
      db.appendTaskComment(initial.id, {
        id: crypto.randomUUID(),
        title: "",
        body: "Обсуждение",
        createdAt: new Date().toISOString(),
        createdBy: "reviewer",
      });
      const current = entities.update(
        initial.id,
        "task",
        { title: "Уточнение" },
        entityWriteOptions(initial),
      );
      const generation = db.getGeneration();

      expectRelayError(
        () => entities.update(initial.id, "task", { comments: [] }, entityWriteOptions(initial)),
        "REVISION_CONFLICT",
      );

      expect(entities.get(initial.id)).toEqual(current);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Разрешение адресов и вида сущности", () => {
  test.each(aliasForms)("$name старый ключ изменяет ту же запись", ({ typed }) => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const initial = entities.create("document", "DOC", { body: "Текст" }, "author");
      const renamed = entities.rename(
        `document:${initial.id}`,
        "document",
        "GUIDE",
        entityWriteOptions(initial),
      );
      const ref = typed ? `document:${initial.key}` : initial.key;

      const updated = entities.update(
        ref,
        "document",
        { body: "После переименования" },
        entityWriteOptions(renamed),
      );

      expect(updated).toMatchObject({
        id: initial.id,
        key: "GUIDE",
        data: { body: "После переименования" },
      });
      expect(entities.get(initial.key)).toEqual(updated);
      expect(entities.get("GUIDE")).toEqual(updated);
      expect(entities.get(`document:${initial.id}`)).toEqual(updated);
    });
  });

  test.each(referenceForms)(
    "типизированный $name разрешает документ с явным и неявным видом",
    ({ field }) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const initial = entities.create("document", "DOC", { body: "Текст" }, "author");
        const renamed = entities.rename(
          initial.id,
          "document",
          "GUIDE",
          entityWriteOptions(initial),
        );
        const ref = `document:${entityReference(initial, renamed, field)}`;

        const implicit = entities.get(ref);
        const explicit = entities.get(ref, "document");

        expect(implicit).toEqual(renamed);
        expect(explicit).toEqual(renamed);
      });
    },
  );

  test.each(referenceForms)(
    "типизированный $name с конфликтом ожидаемого вида даёт INVALID_ARGUMENT",
    ({ field }) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const initial = entities.create("document", "DOC", {}, "author");
        const renamed = entities.rename(
          initial.id,
          "document",
          "GUIDE",
          entityWriteOptions(initial),
        );
        const ref = `document:${entityReference(initial, renamed, field)}`;

        expectRelayError(() => entities.get(ref, "task"), "INVALID_ARGUMENT");
      });
    },
  );

  test.each(referenceForms)("типизированный $name чужого вида даёт NOT_FOUND", ({ field }) => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const initial = entities.create("document", "DOC", {}, "author");
      const renamed = entities.rename(initial.id, "document", "GUIDE", entityWriteOptions(initial));
      const ref = `task:${entityReference(initial, renamed, field)}`;

      expectRelayError(() => entities.get(ref), "NOT_FOUND");
    });
  });

  test.each(invalidReferences)("$name в ссылке даёт INVALID_ARGUMENT", ({ ref }) => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);

      expectRelayError(() => entities.get(ref), "INVALID_ARGUMENT");
    });
  });

  test("чтение отсутствующего адреса даёт NOT_FOUND", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);

      expectRelayError(() => entities.get("MISSING"), "NOT_FOUND");
    });
  });

  test("чтение документа как задачи даёт NOT_FOUND", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const document = entities.create("document", "DOC", {}, "author");

      expectRelayError(() => entities.get(document.key, "task"), "NOT_FOUND");
    });
  });

  test.each(mismatchedKinds)(
    "запись через $name неверного вида сохраняет документ и поколение",
    ({ typed, code }) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const document = entities.create("document", "DOC", {}, "author");
        const generation = db.getGeneration();

        expectRelayError(() => {
          if (typed) {
            return entities.update(
              `task:${document.id}`,
              "document",
              { title: "Задача" },
              entityWriteOptions(document),
            );
          }
          return entities.update(
            document.key,
            "task",
            { title: "Задача" },
            entityWriteOptions(document),
          );
        }, code);

        expect(entities.list("document")).toEqual([document]);
        expect(entities.list("task")).toEqual([]);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );
});

describe("Валидация сущности до записи", () => {
  test.each(invalidAddressOperations)(
    "двоеточие в адресе: %s отклоняется без изменения данных и счётчика",
    (operation) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const created = entities.create("feature", "FEATURE", { name: "Поиск" }, "author");
        const typed = `feature:${created.key}`;
        const snapshot = db.list();
        const generation = db.getGeneration();

        expectRelayError(() => {
          switch (operation) {
            case "ключ":
              return entities.create("feature", "FEATURE", {}, "author", typed);
            case "префикс":
              return entities.create("feature", "feature:FEATURE", {}, "author");
            case "переименование":
              return entities.rename(created.id, "feature", typed, entityWriteOptions(created));
            case "Storage":
              // Намеренный обход Core проверяет запрет неоднозначного адреса в Storage.
              return db.rename(created.id, typed, created.revision, "author");
          }
        }, "VALIDATION_ERROR");

        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
        expect(entities.get(typed)).toEqual(created);
        expect(entities.create("feature", "FEATURE", {}, "author").key).toBe("FEATURE-2");
      });
    },
  );

  test.each(invalidJsonValues)("$name в JSON отклоняется без записи", ({ value }) => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const generation = db.getGeneration();

      expectRelayError(
        () => entities.create("document", "DOC", { value }, "author"),
        "VALIDATION_ERROR",
      );

      expect(entities.list("document")).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("циклический payload отклоняется без записи и расходования ключа", () => {
    withEntityDatabase((db) => {
      const entities = new EntityService(db);
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      const generation = db.getGeneration();

      expectRelayError(
        () => entities.create("document", "DOC", cycle, "author"),
        "VALIDATION_ERROR",
      );

      expect(entities.list("document")).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
      expect(
        entities.create("document", "DOC", { nullable: null, array: [1, "text", true] }, "author")
          .key,
      ).toBe("DOC-1");
    });
  });

  for (const operation of jsonWriteOperations) {
    test.each(invalidArrays)(
      `${operation}: $name не превращается в null и не меняет базу`,
      ({ shape }) => {
        withEntityDatabase((db) => {
          const entities = new EntityService(db);
          const created = entities.create("document", "DOC", { values: [null, "Текст"] }, "author");
          const value = createInvalidArray(shape);
          const snapshot = db.list();
          const generation = db.getGeneration();

          expectRelayError(() => {
            if (operation === "create") {
              return entities.create("document", "DOC", { value }, "author");
            }
            return entities.update(created.id, "document", { value }, entityWriteOptions(created));
          }, "VALIDATION_ERROR");

          expect(db.list()).toEqual(snapshot);
          expect(db.getGeneration()).toBe(generation);
          const next = entities.create("document", "DOC", { values: [null, [], [null]] }, "author");
          expect(next.key).toBe("DOC-2");
          expect(entities.get(next.id).data).toEqual({ values: [null, [], [null]] });
        });
      },
    );
  }

  test.each(invalidIdentityInputs)(
    "$name отклоняется без создания документа",
    ({ actor, key, code }) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const generation = db.getGeneration();

        expectRelayError(() => entities.create("document", "DOC", {}, actor, key), code);

        expect(entities.list("document")).toEqual([]);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test.each(invalidRevisions)(
    "ревизия $name отклоняется без изменения документа",
    ({ revision }) => {
      withEntityDatabase((db) => {
        const entities = new EntityService(db);
        const created = entities.create("document", "DOC", {}, "author");
        const generation = db.getGeneration();

        expectRelayError(
          () =>
            entities.update(created.id, "document", {}, { actor: "author", ifRevision: revision }),
          "VALIDATION_ERROR",
        );

        expect(entities.get(created.id)).toEqual(created);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );
});
