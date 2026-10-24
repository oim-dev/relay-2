import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ProjectDatabase } from "../../src/database/project-database";
import {
  ProjectDatabaseFixture,
  createDocument,
  expectRelayError,
  projectMetadata,
  requireRecord,
} from "./helpers/project-database-fixture";
import type { ImmutableEntityCase } from "./helpers/database-cases.types";

const immutableCases: readonly ImmutableEntityCase[] = [
  { name: "изменение вида", patch: { kind: "task" } },
  { name: "изменение автора создания", patch: { createdBy: "other" } },
  { name: "изменение времени создания", patch: { createdAt: "other" } },
  { name: "пропуск ревизии", patch: { revision: 3 } },
];
const addressCollisions = [
  { name: "ключ совпадает с чужим алиасом", field: "key", address: "key" },
  { name: "ID совпадает с чужим алиасом", field: "id", address: "key" },
  { name: "ключ совпадает с чужим ID", field: "key", address: "id" },
] as const;
const keyWriteCases = [
  { name: "rename", method: "rename", expectedCode: "VALIDATION_ERROR" },
  { name: "insert", method: "insert", expectedCode: "CONFLICT" },
  { name: "update", method: "update", expectedCode: "CONFLICT" },
] as const;
const invalidMutationIds = [
  { name: "отсутствующий ID", reference: "missing" },
  { name: "текущий ключ вместо ID", reference: "key" },
  { name: "алиас вместо ID", reference: "alias" },
] as const;
let fixture: ProjectDatabaseFixture;

beforeEach(() => {
  fixture = new ProjectDatabaseFixture();
});

afterEach(() => {
  fixture.close();
});

describe("Файловая база проекта", () => {
  test("создаёт проект, пустой паспорт и доску; сохраняет схему и WAL после открытия", () => {
    const db = fixture.create();
    const initial = db.list();
    const generation = db.getGeneration();
    db.close();

    const reopened = fixture.open();

    expect(db.path).toBe(fixture.path);
    expect(db.projectId).toBe(projectMetadata.id);
    expect(reopened.path).toBe(fixture.path);
    expect(reopened.projectId).toBe(projectMetadata.id);
    expect(reopened.get("PROJECT")).toMatchObject({
      id: projectMetadata.id,
      kind: "project",
      revision: 1,
      createdBy: "system",
      updatedBy: "system",
      data: { name: projectMetadata.name, slug: projectMetadata.slug },
    });
    expect(reopened.get("PRODUCT")).toMatchObject({ kind: "product", revision: 1, data: {} });
    expect(reopened.get("BOARD-PRODUCT")).toMatchObject({
      kind: "board",
      data: { name: "Продукт", slug: "product", prefix: "PRODUCT" },
    });
    expect(reopened.list()).toHaveLength(3);
    expect(reopened.list()).toEqual(initial);
    expect(reopened.getGeneration()).toBe(generation);
    fixture.withRaw((raw) => {
      expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(raw.query("SELECT data FROM entities WHERE kind = 'project'").get()).toEqual({
        data: JSON.stringify({ name: projectMetadata.name, slug: projectMetadata.slug }),
      });
    });
  });

  test("открытие отсутствующего файла возвращает DATABASE_NOT_FOUND без создания базы", () => {
    const path = fixture.path;

    expectRelayError(() => ProjectDatabase.open(path), "DATABASE_NOT_FOUND");

    expect(existsSync(path)).toBe(false);
  });

  test("создание поверх существующего файла сохраняет его содержимое", () => {
    writeFileSync(fixture.path, "Данные, которые нельзя перезаписать");
    const before = readFileSync(fixture.path);

    expectRelayError(
      () => ProjectDatabase.create(fixture.path, projectMetadata),
      "DATABASE_EXISTS",
    );

    expect(readFileSync(fixture.path)).toEqual(before);
  });

  test("открытие чужого пустого файла не инициализирует его как базу проекта", () => {
    writeFileSync(fixture.path, "");

    expectRelayError(() => ProjectDatabase.open(fixture.path), "DATABASE_INVALID");

    expect(readFileSync(fixture.path)).toHaveLength(0);
  });

  test("неподдерживаемая версия схемы отклоняется при открытии", () => {
    fixture.create().close();
    // Намеренно меняем техническую версию, сохраняя действительную схему базы.
    fixture.withRaw((raw) => raw.exec("PRAGMA user_version = 999"));

    expectRelayError(() => ProjectDatabase.open(fixture.path), "SCHEMA_VERSION_UNSUPPORTED");
  });

  test("неуспешная инициализация удаляет свои файлы и допускает повтор", () => {
    const invalidMetadata = { ...projectMetadata, id: "PRODUCT" };

    expectRelayError(() => ProjectDatabase.create(fixture.path, invalidMetadata), "CONFLICT");

    expect(existsSync(fixture.path)).toBe(false);
    expect(existsSync(`${fixture.path}-wal`)).toBe(false);
    expect(fixture.create().list()).toHaveLength(3);
  });
});

describe("Ревизии и общее пространство ссылок", () => {
  test.each(invalidMutationIds)(
    "$name отклоняется в update и rename без изменения сущности",
    ({ reference }) => {
      const db = fixture.create();
      const original = createDocument();
      db.insert(original);
      const current = db.rename(original.id, "DOC-RENAMED", 1, "editor");
      const generation = db.getGeneration();
      const references = { missing: "missing-id", key: current.key, alias: original.key };
      const id = references[reference];

      const updateError = expectRelayError(
        () => db.update({ ...current, id, revision: 3 }, 2),
        "NOT_FOUND",
      );
      const renameError = expectRelayError(
        () => db.rename(id, current.key, 2, "other-editor"),
        "NOT_FOUND",
      );

      expect(updateError.details).toEqual({ id });
      expect(renameError.details).toEqual({ id });
      expect(db.get(original.id)).toEqual(current);
      expect(db.get(original.key)).toEqual(current);
      expect(db.getGeneration()).toBe(generation);
    },
  );

  test.each(keyWriteCases)(
    "$name запрещает ключ с синтаксисом типизированной ссылки",
    ({ method, expectedCode }) => {
      const db = fixture.create();
      const existing = createDocument();
      db.insert(existing);
      const generation = db.getGeneration();

      expectRelayError(() => {
        if (method === "rename") {
          db.rename(existing.id, "document:DOC-OTHER", existing.revision, "tester");
        } else if (method === "insert") {
          db.insert(createDocument("document:DOC-1"));
        } else {
          db.update({ ...existing, key: "document:DOC-1", revision: 2 }, 1);
        }
      }, expectedCode);

      expect(db.get(existing.id)).toEqual(existing);
      expect(db.getGeneration()).toBe(generation);
    },
  );

  test("CAS сохраняет победившую запись и проверяется перед no-op rename", () => {
    const first = fixture.create();
    const second = fixture.open();
    const entity = createDocument();
    first.insert(entity);
    const stale = requireRecord(second, entity.id);
    first.update({ ...entity, revision: 2, data: { title: "Первый редактор" } }, 1);
    const generation = first.getGeneration();

    const conflict = expectRelayError(
      () => second.update({ ...stale, revision: 2, data: { title: "Устаревший редактор" } }, 1),
      "REVISION_CONFLICT",
    );

    expect(conflict.exitCode).toBe(4);
    expect(conflict.details).toMatchObject({ expectedRevision: 1, actualRevision: 2 });
    expectRelayError(() => second.rename(entity.id, entity.key, 1, "tester"), "REVISION_CONFLICT");
    expect(second.get(entity.id)?.data).toEqual({ title: "Первый редактор" });
    expect(second.getGeneration()).toBe(generation);
  });

  test("алиасы переживают возврат прежнего ключа и повторное открытие базы", () => {
    const db = fixture.create();
    const entity = createDocument();
    db.insert(entity);

    const renamed = db.rename(entity.id, "DOC-2", 1, "renamer");

    expect(renamed).toMatchObject({
      id: entity.id,
      key: "DOC-2",
      revision: 2,
      createdBy: "tester",
      updatedBy: "renamer",
    });
    expect(db.get("DOC-1")).toEqual(renamed);
    expect(db.get(entity.id)).toEqual(renamed);
    expect(db.get("DOC-1", "task")).toBeUndefined();
    expect(db.nextKey("DOC")).toBe("DOC-3");
    const restored = db.rename(entity.id, "DOC-1", 2, "renamer");
    expect(db.get("DOC-2")).toEqual(restored);
    db.close();
    const reopened = fixture.open();
    expect(reopened.get("DOC-2")).toEqual(restored);
    expect(reopened.nextKey("DOC")).toBe("DOC-4");
  });

  test.each(addressCollisions)(
    "$name: вставка отклоняется без частичной записи",
    ({ field, address }) => {
      const db = fixture.create();
      const entity = createDocument();
      db.insert(entity);
      const renamed = db.rename(entity.id, "DOC-2", 1, "renamer");
      const candidate = { ...createDocument("OTHER"), [field]: entity[address] };
      const generation = db.getGeneration();

      expectRelayError(() => db.insert(candidate), "CONFLICT");

      expect(db.list("document")).toEqual([renamed]);
      expect(db.getGeneration()).toBe(generation);
    },
  );

  test.each(immutableCases)("$name отклоняется без изменения сущности", ({ patch }) => {
    const db = fixture.create();
    const entity = createDocument();
    db.insert(entity);
    const generation = db.getGeneration();

    expectRelayError(() => db.update({ ...entity, revision: 2, ...patch }, 1), "CONFLICT");

    expect(db.get(entity.id)).toEqual(entity);
    expect(db.getGeneration()).toBe(generation);
  });

  test("конфликт нового ключа не оставляет алиаса или новой ревизии", () => {
    const db = fixture.create();
    const first = createDocument("DOC-1");
    const second = createDocument("DOC-2");
    db.insert(first);
    db.insert(second);
    const generation = db.getGeneration();

    expectRelayError(() => db.rename(first.id, second.key, 1, "tester"), "CONFLICT");

    expect(db.get(first.id)).toEqual(first);
    expect(db.get(second.key)).toEqual(second);
    expect(db.getGeneration()).toBe(generation);
  });
});
