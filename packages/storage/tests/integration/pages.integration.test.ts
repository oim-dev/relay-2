import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { EntityRecord, KnowledgeRecord } from "@relay/contracts";
import type { ProjectDatabase } from "../../src/database/project-database";
import {
  ProjectDatabaseFixture,
  createDocument,
  createTask,
} from "./helpers/project-database-fixture";
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
 * Формирует полный документ с одинаковым временем для проверки SQL-окон и устойчивой сортировки.
 * Запись в БД остаётся явным действием теста.
 */
function createPageDocument(key: string, name: string, body = "Полное содержание"): EntityRecord {
  return {
    ...createDocument(key, { name, body }),
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    createdBy: "author",
    updatedBy: "author",
  };
}

/**
 * Создаёт две доски с общим адресом и переименовывает первую для проверки ID/ключа/алиаса.
 * Возвращает независимые ожидаемые идентичности; все записи принадлежат БД текущего теста.
 */
function createAddressedBoards(database: ProjectDatabase): AddressedBoards {
  const first: KnowledgeRecord<"board"> = {
    ...createPageDocument("BOARD-1", "Первая доска"),
    id: "board-1",
    kind: "board",
    data: {
      name: "Первая доска",
      slug: "shared",
      prefix: "FIRST",
      description: "НЕ-ЧИТАТЬ-СОДЕРЖАНИЕ-ДОСКИ",
      applicationId: "application-1",
    },
  };
  const second: KnowledgeRecord<"board"> = {
    ...createPageDocument("BOARD-2", "Вторая доска"),
    id: "board-2",
    kind: "board",
    data: {
      name: "Вторая доска",
      slug: "second",
      prefix: "shared",
      applicationId: "application-2",
    },
  };
  database.transaction(() => {
    for (const [index, board] of [first, second].entries()) {
      database.insert({
        ...createPageDocument(`APP-${index + 1}`, board.data.name),
        id: `application-${index + 1}`,
        kind: "application",
        data: {
          name: board.data.name,
          summary: "",
          description: "",
          slug: `${board.data.slug}-app`,
          prefix: board.data.prefix,
          type: "internal",
          boardId: board.id,
          implementationIds: [],
        },
      });
      database.insert(board);
    }
  });
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

  test.each(["title", "updated"] as const)(
    "%s сохраняет порядок по ID при равных значениях",
    (sort) => {
      const later = { ...createPageDocument("DOC-1", "Общее название"), id: "document-z" };
      const earlier = { ...createPageDocument("DOC-2", "Общее название"), id: "document-a" };
      db.insert(later);
      db.insert(earlier);

      const first = db.listPage("document", { offset: 0, limit: 1, sort });
      const second = db.listPage("document", { offset: 1, limit: 1, sort });

      expect(first).toEqual({ total: 2, items: [earlier] });
      expect(second).toEqual({ total: 2, items: [later] });
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
    const task = createTask(db, "TASK-1", {
      title: "Техническая задача",
      description: "ТЕКСТ-ЗАДАЧИ",
      column: "ready",
      acceptanceCriteria: [
        {
          id: "criterion",
          title: "Критерий",
          summary: "",
          completed: false,
          completedAt: null,
          completedBy: null,
          description: "ТЕКСТ-КРИТЕРИЯ",
        },
      ],
    });
    db.insert(task);
    db.appendTaskComment(task.id, {
      id: "comment-id",
      title: "Комментарий",
      body: "ТЕКСТ-КОММЕНТАРИЯ",
      createdAt: task.createdAt,
      createdBy: "author",
    });

    const decoder = spyOn(JSON, "parse");
    try {
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
      expect(decoder.mock.calls.some(([text]) => text.includes("ТЕКСТ-"))).toBe(false);
    } finally {
      decoder.mockRestore();
    }
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
      expect(otherKind).toEqual([{ id: "application-2", kind: "application", key: "APP-2" }]);
      expect(decoder).not.toHaveBeenCalled();
    } finally {
      decoder.mockRestore();
    }
  });
});
