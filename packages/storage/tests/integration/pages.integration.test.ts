import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { EntityRecord } from "@relay/contracts";
import type { ProjectDatabase } from "../../src/database/project-database";
import { ProjectDatabaseFixture } from "./helpers/project-database-fixture";
import type { AddressedBoards } from "./helpers/page-records.types";

const pageCases = [
  {
    name: "сортировка по заголовку",
    options: { offset: 0, limit: 1, sort: "title" },
    expected: "second",
  },
  { name: "смещение по ключу", options: { offset: 1, limit: 1, sort: "key" }, expected: "second" },
  {
    name: "смещение за конец набора",
    options: { offset: 2, limit: 1, sort: "key" },
    expected: "empty",
  },
] as const;
const identityReferences = [
  { name: "постоянный ID", reference: "id" },
  { name: "текущий ключ", reference: "key" },
  { name: "сохранённый алиас", reference: "alias" },
] as const;
const missingIdentityCases = [
  { name: "несовпадающий вид", ref: "board-1", kind: "task" },
  { name: "отсутствующая ссылка", ref: "missing", kind: undefined },
] as const;
let fixture: ProjectDatabaseFixture;
let db: ProjectDatabase;

/**
 * Формирует технический JSON-документ для проверки окна SQL, не сохраняя его в БД.
 * Поля name/body намеренно минимальны: предметное декодирование документа принадлежит Core.
 */
function createPageDocument(key: string, name: string, body = "Полное содержание"): EntityRecord {
  return {
    id: crypto.randomUUID(),
    kind: "document",
    key,
    revision: 1,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    createdBy: "author",
    updatedBy: "author",
    data: { name, body },
  };
}

/**
 * Создаёт две доски с общим адресом и переименовывает первую для проверки ID/ключа/алиаса.
 * Возвращает независимые ожидаемые идентичности; все записи принадлежат БД текущего теста.
 */
function createAddressedBoards(database: ProjectDatabase): AddressedBoards {
  const first: EntityRecord = {
    ...createPageDocument("BOARD-1", "Первая доска"),
    id: "board-1",
    kind: "board",
    data: { slug: "shared", prefix: "FIRST", description: "НЕ-ЧИТАТЬ-СОДЕРЖАНИЕ-ДОСКИ" },
  };
  const second: EntityRecord = {
    ...createPageDocument("BOARD-2", "Вторая доска"),
    id: "board-2",
    kind: "board",
    data: { slug: "second", prefix: "shared" },
  };
  database.insert(first);
  database.insert(second);
  database.rename(first.id, "BOARD-RENAMED", first.revision, "author");
  return { first, second, identity: { id: first.id, kind: "board", key: "BOARD-RENAMED" } };
}

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("pages");
  db = fixture.create();
});

afterEach(() => {
  fixture.close();
});

describe("Ограниченные SQL-страницы сущностей", () => {
  test("окно сохраняет полное содержание выбранной записи, не декодируя остальные", () => {
    const first = createPageDocument("DOC-1", "Я");
    const second = createPageDocument("DOC-2", "А", "НЕЗАГРУЖЕННОЕ-СОДЕРЖАНИЕ");
    db.insert(first);
    db.insert(second);
    const parse = JSON.parse;
    const decoded: string[] = [];
    const decoder = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      decoded.push(text);
      return parse(text, reviver);
    });
    try {
      const page = db.listPage("document", { offset: 0, limit: 1, sort: "key" });

      expect(page).toEqual({ total: 2, items: [first] });
      expect(decoded.some((text) => text.includes("НЕЗАГРУЖЕННОЕ-СОДЕРЖАНИЕ"))).toBe(false);
    } finally {
      decoder.mockRestore();
    }
  });

  test.each(pageCases)(
    "$name сохраняет полный счётчик и выбранное окно",
    ({ options, expected }) => {
      const first = createPageDocument("DOC-1", "Я");
      const second = createPageDocument("DOC-2", "А");
      db.insert(first);
      db.insert(second);
      const expectedItems = expected === "empty" ? [] : [second];

      const page = db.listPage("document", options);

      expect(page).toEqual({ total: 2, items: expectedItems });
    },
  );

  test("счётчик и окно относятся к одному снимку при конкурентном добавлении", () => {
    const first = createPageDocument("DOC-1", "Первая запись");
    db.insert(first);
    const writer = fixture.open();
    const count = db.count.bind(db);
    const counter = spyOn(db, "count").mockImplementation((kind) => {
      const total = count(kind);
      // Публикуем запись строго между чтением счётчика и чтением окна, без временных задержек.
      writer.insert(createPageDocument("DOC-2", "Конкурентная запись"));
      return total;
    });
    try {
      const page = db.listPage("document", { offset: 0, limit: 10, sort: "key" });

      expect(page).toEqual({ total: 1, items: [first] });
    } finally {
      counter.mockRestore();
    }
    expect(db.count("document")).toBe(2);
  });
});

describe("Узкие SQL-проекции", () => {
  test("граф задач не загружает текст и независимый журнал комментариев", () => {
    const task: EntityRecord = {
      ...createPageDocument("TASK-1", "Техническая задача"),
      kind: "task",
      data: {
        description: "ТЕКСТ-ЗАДАЧИ",
        column: "ready",
        parentId: null,
        dependencies: [],
        acceptanceCriteria: [{ completed: false, description: "ТЕКСТ-КРИТЕРИЯ" }],
      },
    };
    db.insert(task);
    db.appendTaskComment(task.id, {
      id: "comment-id",
      title: "Комментарий",
      body: "ТЕКСТ-КОММЕНТАРИЯ",
      createdAt: task.createdAt,
      createdBy: "author",
    });

    const graph = db.listTaskGraph();

    expect(graph).toEqual([
      {
        ...task,
        data: {
          column: "ready",
          parentId: null,
          dependencies: [],
          acceptanceCriteria: [{ completed: false }],
        },
      },
    ]);
  });

  test.each(identityReferences)(
    "$name разрешается в идентичность без десериализации JSON",
    ({ reference }) => {
      const { first, identity } = createAddressedBoards(db);
      const references = { id: first.id, key: identity.key, alias: first.key };
      const decoder = spyOn(JSON, "parse");
      try {
        const resolved = db.getIdentity(references[reference], "board");

        expect(resolved).toEqual(identity);
        expect(decoder).not.toHaveBeenCalled();
      } finally {
        decoder.mockRestore();
      }
    },
  );

  test.each(missingIdentityCases)(
    "$name возвращает отсутствие идентичности без чтения JSON",
    ({ ref, kind }) => {
      createAddressedBoards(db);
      const decoder = spyOn(JSON, "parse");
      try {
        const identity = db.getIdentity(ref, kind);

        expect(identity).toBeUndefined();
        expect(decoder).not.toHaveBeenCalled();
      } finally {
        decoder.mockRestore();
      }
    },
  );

  test("поиск адреса возвращает все совпадения slug/prefix только выбранного вида без чтения JSON", () => {
    const { second, identity } = createAddressedBoards(db);
    const decoder = spyOn(JSON, "parse");
    try {
      // Storage возвращает технические совпадения; неоднозначность разрешает Core.
      const matches = db.findAddressIdentities("shared", "board");
      const otherKind = db.findAddressIdentities("shared", "application");

      expect(matches).toEqual([identity, { id: second.id, kind: "board", key: second.key }]);
      expect(otherKind).toEqual([]);
      expect(decoder).not.toHaveBeenCalled();
    } finally {
      decoder.mockRestore();
    }
  });
});
