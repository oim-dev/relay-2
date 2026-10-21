import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../../src/entities";
import * as publicCore from "../../src/index";

const artifacts = resolve(
  import.meta.dir,
  "../../../..",
  ".artifacts",
  new Date().toISOString().slice(0, 10),
);
let directory: string;
let db: ProjectDatabase;
let entities: EntityService;

test("публичный Core не экспортирует универсальную мутацию сущностей", () => {
  expect(Object.hasOwn(publicCore, "EntityService")).toBe(false);
});

beforeEach(() => {
  mkdirSync(artifacts, { recursive: true });
  directory = mkdtempSync(join(artifacts, "core-entities-"));
  db = ProjectDatabase.create(join(directory, "project.sqlite"), {
    id: crypto.randomUUID(),
    name: "Тест",
    slug: "test",
  });
  entities = new EntityService(db);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function expectCode(operation: () => unknown, code: string): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RelayError);
  expect((caught as RelayError).code).toBe(code);
}

describe("Общий механизм сущностей Core", () => {
  test("задача возвращает актуальную проекцию комментариев, а её снимок не заменяет журнал", () => {
    const created = entities.create("task", "TASK", { title: "Задача" }, "author");
    expect(created).toEqual(entities.get(created.id));
    expect(created.data.comments).toEqual([]);
    const entry = {
      id: crypto.randomUUID(),
      title: "",
      body: "Обсуждение",
      createdAt: new Date().toISOString(),
      createdBy: "reviewer",
    };
    db.appendTaskComment(created.id, entry);
    const generation = db.getGeneration();
    const unchanged = entities.update(
      created.id,
      "task",
      { comments: [] },
      { actor: "author", ifRevision: 1 },
    );
    expect(unchanged.revision).toBe(1);
    expect(unchanged.data.comments).toEqual([entry]);
    expect(db.getGeneration()).toBe(generation);
    const updated = entities.update(
      created.id,
      "task",
      { ...created.data, title: "Уточнение" },
      { actor: "author", ifRevision: 1 },
    );
    expect(updated.revision).toBe(2);
    expect(updated.data.comments).toEqual([entry]);
    expect(updated).toEqual(entities.get(created.id));
    expectCode(
      () =>
        entities.update(created.id, "task", { comments: [] }, { actor: "author", ifRevision: 1 }),
      "REVISION_CONFLICT",
    );
  });

  test("создаёт независимую запись, сохраняет авторство и обновляет только payload", () => {
    const input = { title: "Документ", nested: { enabled: true } };
    const created = entities.create("document", "DOC", input, "author");
    input.nested.enabled = false;
    expect(created.key).toBe("DOC-1");
    expect(entities.get(created.id).data).toEqual({ title: "Документ", nested: { enabled: true } });
    const updated = entities.update(
      created.key,
      "document",
      { title: "Новый заголовок" },
      { actor: "editor", ifRevision: 1 },
    );
    expect(updated).toMatchObject({
      id: created.id,
      key: created.key,
      revision: 2,
      createdBy: "author",
      createdAt: created.createdAt,
      updatedBy: "editor",
      data: { title: "Новый заголовок", nested: { enabled: true } },
    });
    expect(entities.get(created.id)).toEqual(updated);
  });

  test("no-op не меняет ревизию, дату и поколение, но отклоняет устаревшего автора", () => {
    const created = entities.create("document", "DOC", { title: "Текст" }, "author");
    const updated = entities.update(
      created.id,
      "document",
      { title: "Новый текст" },
      { actor: "editor", ifRevision: 1 },
    );
    const generation = db.getGeneration();
    expect(
      entities.update(
        created.id,
        "document",
        { title: "Новый текст" },
        { actor: "other", ifRevision: 2 },
      ),
    ).toEqual(updated);
    expect(
      entities.rename(created.id, "document", created.key, { actor: "other", ifRevision: 2 }),
    ).toEqual(updated);
    expectCode(
      () =>
        entities.update(
          created.id,
          "document",
          { title: "Новый текст" },
          { actor: "stale", ifRevision: 1 },
        ),
      "REVISION_CONFLICT",
    );
    expectCode(
      () => entities.rename(created.id, "document", created.key, { actor: "stale", ifRevision: 1 }),
      "REVISION_CONFLICT",
    );
    expect(db.getGeneration()).toBe(generation);
  });

  test("принимает прежний ключ для изменения той же сущности", () => {
    const created = entities.create("document", "DOC", { title: "Текст" }, "author");
    const renamed = entities.rename(created.key, "document", "DOC-NEW", {
      actor: "editor",
      ifRevision: 1,
    });
    expect(renamed.id).toBe(created.id);
    const updated = entities.update(
      created.key,
      "document",
      { title: "После переименования" },
      { actor: "editor", ifRevision: 2 },
    );
    expect(updated.key).toBe("DOC-NEW");
    expect(entities.get(created.key)).toEqual(updated);
    expect(entities.get("DOC-NEW")).toEqual(updated);
  });

  test("различает виды и не обновляет запись неверного вида", () => {
    const created = entities.create("document", "DOC", {}, "author");
    expectCode(() => entities.get(created.key, "task"), "NOT_FOUND");
    expectCode(
      () =>
        entities.update(
          created.key,
          "task",
          { title: "Задача" },
          { actor: "author", ifRevision: 1 },
        ),
      "NOT_FOUND",
    );
    expectCode(() => entities.get("MISSING"), "NOT_FOUND");
    expect(entities.list("document")).toEqual([created]);
    expect(entities.list("task")).toEqual([]);
  });

  test("типизированные ID, ключи и алиасы проверяют вид до чтения и записи", () => {
    const created = entities.create("document", "DOC", { body: "Текст" }, "author");
    const renamed = entities.rename(`document:${created.id}`, "document", "GUIDE", {
      actor: "author",
      ifRevision: created.revision,
    });
    for (const ref of [created.id, created.key, renamed.key]) {
      expect(entities.get(`document:${ref}`)).toEqual(renamed);
      expect(entities.get(`document:${ref}`, "document")).toEqual(renamed);
      expectCode(() => entities.get(`document:${ref}`, "task"), "INVALID_ARGUMENT");
      expectCode(() => entities.get(`task:${ref}`), "NOT_FOUND");
    }
    const snapshot = db.list();
    const generation = db.getGeneration();
    expectCode(
      () =>
        entities.update(
          `task:${created.id}`,
          "document",
          { body: "Неверный вид" },
          { actor: "author", ifRevision: renamed.revision },
        ),
      "INVALID_ARGUMENT",
    );
    for (const ref of ["unknown:GUIDE", "document:", "document:task:GUIDE"])
      expectCode(() => entities.get(ref), "INVALID_ARGUMENT");
    expect(db.list()).toEqual(snapshot);
    expect(db.getGeneration()).toBe(generation);
    const updated = entities.update(
      `document:${created.key}`,
      "document",
      { body: "После переименования" },
      { actor: "author", ifRevision: renamed.revision },
    );
    expect(entities.get(`document:${created.id}`)).toEqual(updated);
  });

  test("двоеточие запрещено в ключах и генерирующих их префиксах без изменения базы", () => {
    const created = entities.create("feature", "FEATURE", { name: "Поиск" }, "author");
    const typed = `feature:${created.key}`;
    const snapshot = db.list();
    const generation = db.getGeneration();
    for (const operation of [
      () => entities.create("feature", "FEATURE", {}, "author", typed),
      () => entities.create("feature", "feature:FEATURE", {}, "author"),
      () =>
        entities.rename(created.id, "feature", typed, {
          actor: "author",
          ifRevision: created.revision,
        }),
    ]) {
      expectCode(operation, "VALIDATION_ERROR");
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    }
    const next = entities.create("feature", "FEATURE", {}, "author");
    expect(next.key).toBe("FEATURE-2");
    // Даже низкоуровневое переименование не создаёт неоднозначный адрес.
    expectCode(() => db.rename(next.id, typed, next.revision, "author"), "VALIDATION_ERROR");
    expect(entities.get(typed).id).toBe(created.id);
    expect(entities.get(next.id)).toEqual(next);
    expectCode(() => entities.get(typed, "document"), "INVALID_ARGUMENT");
  });

  test("составная операция откатывает сущности и счётчик", () => {
    const generation = db.getGeneration();
    expect(() =>
      db.transaction(() => {
        entities.create("document", "DOC", {}, "author");
        entities.create("document", "DOC", {}, "author");
        throw new RelayError("INVALID_LINK", "Несуществующая ссылка", 2);
      }),
    ).toThrow("Несуществующая ссылка");
    expect(entities.list("document")).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
    expect(entities.create("document", "DOC", {}, "author").key).toBe("DOC-1");
  });

  test.each([undefined, NaN, Infinity, 1n, () => {}, new Date(), new Map()])(
    "отклоняет не-JSON значение %p до записи",
    (value) => {
      const generation = db.getGeneration();
      expectCode(() => entities.create("document", "DOC", { value }, "author"), "VALIDATION_ERROR");
      expect(entities.list("document")).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
    },
  );

  test("отклоняет циклический payload без расходования ключа", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expectCode(() => entities.create("document", "DOC", cycle, "author"), "VALIDATION_ERROR");
    expect(
      entities.create("document", "DOC", { nullable: null, array: [1, "text", true] }, "author")
        .key,
    ).toBe("DOC-1");
  });

  test("пропуски и undefined в массивах не превращаются в null при create/update", () => {
    const created = entities.create("document", "DOC", { values: [null, "Текст"] }, "author");
    const sparse: unknown[] = [];
    sparse[2] = "Последнее значение";
    const tail: unknown[] = ["Первое значение"];
    tail.length = 2;
    const snapshot = db.list();
    const generation = db.getGeneration();
    for (const value of [sparse, tail, [undefined], { nested: [sparse] }]) {
      expectCode(() => entities.create("document", "DOC", { value }, "author"), "VALIDATION_ERROR");
      expectCode(
        () =>
          entities.update(created.id, "document", { value }, { actor: "author", ifRevision: 1 }),
        "VALIDATION_ERROR",
      );
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    }
    const next = entities.create("document", "DOC", { values: [null, [], [null]] }, "author");
    expect(next.key).toBe("DOC-2");
    expect(entities.get(next.id).data).toEqual({ values: [null, [], [null]] });
  });

  test("проверяет автора, ключ и положительную целую ожидаемую ревизию", () => {
    expectCode(() => entities.create("document", "DOC", {}, " "), "INVALID_ARGUMENT");
    expectCode(
      () => entities.create("document", "DOC", {}, "author", "BAD KEY"),
      "VALIDATION_ERROR",
    );
    const created = entities.create("document", "DOC", {}, "author");
    for (const revision of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(
        () =>
          entities.update(created.id, "document", {}, { actor: "author", ifRevision: revision }),
        "VALIDATION_ERROR",
      );
    }
    expect(entities.get(created.id)).toEqual(created);
  });
});
