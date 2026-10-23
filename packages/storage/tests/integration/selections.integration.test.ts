import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { EntityRecord } from "@relay/contracts";
import type { ProjectDatabase } from "../../src/database/project-database";
import {
  ProjectDatabaseFixture,
  createComment,
  createDocument,
  expectRelayError,
} from "./helpers/project-database-fixture";

const batchMethods = ["getMany", "getManyIdentities"] as const;
const literalFields = [
  { name: "имя с точкой", field: "owner.id", value: "owner" },
  { name: "пустое имя и значение", field: "", value: "" },
  {
    name: "кавычки и синтаксис SQL",
    field: "owner[0].\"id' OR 1=1 --",
    value: "value' OR 1=1 --",
  },
] as const;
let fixture: ProjectDatabaseFixture;
let db: ProjectDatabase;

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("selections");
  db = fixture.create();
});

afterEach(() => {
  fixture.close();
});

describe("Выборки по строковому полю содержания", () => {
  test("один запрос отбирает только точные строки нужного вида и сортирует по ключу", () => {
    const first = { ...createDocument("DOC-A"), data: { ownerId: "42", title: "Первый" } };
    const second = { ...createDocument("DOC-Z"), data: { ownerId: "42", title: "Второй" } };
    // Разные типы, вложенное поле и чужой владелец не должны попасть в строковый фильтр.
    const excludedData = [
      { ownerId: 42 },
      { ownerId: true },
      { ownerId: null },
      { ownerId: ["42"] },
      { ownerId: { value: "42" } },
      { nested: { ownerId: "42" } },
      { ownerId: "other" },
    ];
    db.insert(second);
    for (const [index, data] of excludedData.entries()) {
      db.insert({
        ...createDocument(`OTHER-${index}`),
        data: { ...data, title: "НЕ-ЧИТАТЬ-ЧУЖОЕ-СОДЕРЖАНИЕ" },
      });
    }
    db.insert({
      ...createDocument("FEATURE-1"),
      kind: "feature",
      data: { ownerId: "42", title: "НЕ-ЧИТАТЬ-ДРУГОЙ-ВИД" },
    });
    db.insert(first);
    const query = spyOn(Database.prototype, "query");
    const decoder = spyOn(JSON, "parse");
    try {
      const selected = db.listByField("document", "ownerId", "42");

      expect(selected).toEqual([first, second]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(decoder.mock.calls.some(([text]) => text.includes("НЕ-ЧИТАТЬ"))).toBe(false);
    } finally {
      decoder.mockRestore();
      query.mockRestore();
    }
  });

  test.each(literalFields)(
    "$name сравнивается буквально на верхнем уровне JSON",
    ({ field, value }) => {
      const selected = { ...createDocument("DOC-1"), data: { [field]: value } };
      const nested = { ...createDocument("DOC-2"), data: { owner: { id: value } } };
      db.insert(nested);
      db.insert(selected);

      const records = db.listByField("document", field, value);
      const missing = db.listByField("document", field, `${value}-missing`);

      expect(records).toEqual([selected]);
      expect(missing).toEqual([]);
    },
  );

  test("фильтр задачи возвращает весь журнал только выбранного владельца", () => {
    const selected: EntityRecord = {
      ...createDocument("TASK-1"),
      kind: "task",
      data: { ownerId: "selected", title: "Нужная задача" },
    };
    const excluded: EntityRecord = {
      ...createDocument("TASK-2"),
      kind: "task",
      data: { ownerId: "other", title: "НЕ-ЧИТАТЬ-ЗАДАЧУ" },
    };
    db.insert(selected);
    db.insert(excluded);
    const comment = createComment("Полный текст выбранного комментария");
    db.appendTaskComment(selected.id, comment);
    db.appendTaskComment(excluded.id, createComment("НЕ-ЧИТАТЬ-ЖУРНАЛ"));
    const query = spyOn(Database.prototype, "query");
    const decoder = spyOn(JSON, "parse");
    try {
      const records = db.listByField("task", "ownerId", "selected");

      expect(records).toEqual([{ ...selected, data: { ...selected.data, comments: [comment] } }]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(decoder.mock.calls.some(([text]) => text.includes("НЕ-ЧИТАТЬ"))).toBe(false);
    } finally {
      decoder.mockRestore();
      query.mockRestore();
    }
  });
});

describe("Пакетные чтения постоянных ID", () => {
  test.each(batchMethods)(
    "%s сохраняет порядок и повторы, пропуская отсутствующие ID, ключи и алиасы",
    (method) => {
      const document = { ...createDocument("DOC-OLD"), id: "document' OR 1=1 --" };
      const task: EntityRecord = { ...createDocument("TASK-1"), kind: "task" };
      db.insert(document);
      db.insert(task);
      const renamed = db.rename(document.id, "DOC-NEW", 1, "editor");
      const first = createComment("Первое сообщение");
      const second = { ...createComment("Второе сообщение"), createdAt: "2000-01-01" };
      db.appendTaskComment(task.id, first);
      db.appendTaskComment(task.id, second);
      db.insert({ ...createDocument("UNRELATED"), data: { title: "НЕ-ЧИТАТЬ-ДРУГОЙ-ID" } });
      const ids = [task.id, "missing", document.key, renamed.key, document.id, task.id] as const;
      const query = spyOn(Database.prototype, "query");
      const decoder = spyOn(JSON, "parse");
      try {
        const records = db[method](ids);

        if (method === "getMany") {
          const expectedTask = { ...task, data: { ...task.data, comments: [first, second] } };
          expect(records).toEqual([expectedTask, renamed, expectedTask]);
          expect(decoder.mock.calls.some(([text]) => text.includes("НЕ-ЧИТАТЬ"))).toBe(false);
        } else {
          expect(records).toEqual([
            { id: task.id, kind: "task", key: task.key },
            { id: document.id, kind: "document", key: "DOC-NEW" },
            { id: task.id, kind: "task", key: task.key },
          ]);
          expect(decoder).not.toHaveBeenCalled();
        }
        expect(query).toHaveBeenCalledTimes(1);
      } finally {
        decoder.mockRestore();
        query.mockRestore();
      }
    },
  );

  test.each(batchMethods)("%s исключает другой вид до декодирования карточек", (method) => {
    const selected = createDocument();
    const otherKind: EntityRecord = { ...createDocument("TASK-1"), kind: "task" };
    db.insert(selected);
    db.insert(otherKind);
    fixture.withRaw((raw) => {
      // Повреждённая карточка другого вида делает случайное полное декодирование наблюдаемым.
      raw.exec("PRAGMA ignore_check_constraints = ON");
      raw
        .query("UPDATE entities SET revision = revision + 1, data = 'null' WHERE id = ?")
        .run(otherKind.id);
    });

    const records = db[method]([otherKind.id, selected.id, "missing"], "document");

    expect(records).toEqual(
      method === "getMany"
        ? [selected]
        : [{ id: selected.id, kind: "document", key: selected.key }],
    );
    expectRelayError(() => db.getMany([otherKind.id], "task"), "STORAGE_ERROR");
  });

  test("идентичности доступны без декодирования даже при повреждённом содержании", () => {
    const document = createDocument();
    db.insert(document);
    fixture.withRaw((raw) => {
      raw.exec("PRAGMA ignore_check_constraints = ON");
      raw
        .query("UPDATE entities SET revision = revision + 1, data = 'null' WHERE id = ?")
        .run(document.id);
    });
    const decoder = spyOn(JSON, "parse");
    try {
      const identities = db.getManyIdentities([document.id], "document");

      expect(identities).toEqual([{ id: document.id, kind: "document", key: document.key }]);
      expect(decoder).not.toHaveBeenCalled();
    } finally {
      decoder.mockRestore();
    }
  });

  test.each(batchMethods)("%s возвращает пустой пакет без SQL и декодирования", (method) => {
    const query = spyOn(Database.prototype, "query");
    const decoder = spyOn(JSON, "parse");
    try {
      const records = db[method]([], "document");

      expect(records).toEqual([]);
      expect(query).not.toHaveBeenCalled();
      expect(decoder).not.toHaveBeenCalled();
    } finally {
      decoder.mockRestore();
      query.mockRestore();
    }
  });

  test("закрытое соединение отклоняет все новые выборки, включая пустой пакет", () => {
    db.close();

    expectRelayError(() => db.getMany([]), "DATABASE_CLOSED");
    expectRelayError(() => db.getManyIdentities([]), "DATABASE_CLOSED");
    expectRelayError(() => db.listByField("document", "ownerId", "owner"), "DATABASE_CLOSED");
  });
});
