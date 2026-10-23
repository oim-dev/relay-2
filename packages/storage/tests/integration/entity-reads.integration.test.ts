import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { createDocument, ProjectDatabaseFixture } from "./helpers/project-database-fixture";

const invalidFields = [
  {
    name: "явный null заголовка",
    data: { name: null },
    expected: { title: null, state: undefined, active: undefined },
  },
  {
    name: "объект вместо заголовка",
    data: { name: { bad: true } },
    expected: { title: { bad: true }, state: undefined, active: undefined },
  },
] as const;

describe("Адресное пакетное разрешение Storage", () => {
  test("ID, ключи, алиасы, пропуски и повторы сохраняют исходные позиции без чтения содержания", () => {
    const fixture = new ProjectDatabaseFixture("read-addresses");
    try {
      const db = fixture.create();
      const first = createDocument("DOC-1");
      const second = createDocument("DOC-2");
      db.insert(first);
      db.insert(second);
      db.rename(first.id, "RENAMED", first.revision, "tester");
      const parse = spyOn(JSON, "parse");
      const queries = spyOn(Database.prototype, "query");
      try {
        const result = db.resolveMany([
          second.key,
          "absent",
          first.id,
          first.key,
          "RENAMED",
          first.key,
        ]);

        const identity = { id: first.id, kind: "document", key: "RENAMED" } as const;
        expect(result).toEqual([
          { id: second.id, kind: "document", key: second.key },
          null,
          identity,
          identity,
          identity,
          identity,
        ]);
        expect(parse).not.toHaveBeenCalled();
        expect(queries).toHaveBeenCalledTimes(1);
        // Проверяем границу SQLite → TypeScript: отбросить уже загруженное data недостаточно.
        const columns = queries.mock.results
          .filter((result) => result.type === "return")
          .flatMap((result) => result.value.columnNames);
        expect(columns.toSorted()).toEqual(["id", "key", "kind", "ref"]);
      } finally {
        queries.mockRestore();
        parse.mockRestore();
      }
    } finally {
      fixture.close();
    }
  });
});

describe("Краткая адресная SQL-проекция", () => {
  test("только выбранные поля передаются в TypeScript без тел, критериев и журнала", () => {
    const fixture = new ProjectDatabaseFixture("read-summary");
    try {
      const db = fixture.create();
      const document = {
        ...createDocument(),
        data: { name: "Документ", documentStatus: "active", body: "НЕ-ЗАГРУЖАТЬ-ТЕЛО" },
      };
      const task = {
        ...createDocument("TASK-1"),
        kind: "task" as const,
        data: {
          title: "Задача",
          column: "review",
          description: "НЕ-ЗАГРУЖАТЬ-ОПИСАНИЕ",
          acceptanceCriteria: [{ title: "НЕ-ЗАГРУЖАТЬ-КРИТЕРИЙ" }],
        },
      };
      db.insert(document);
      db.insert(task);
      db.appendTaskComment(task.id, {
        id: "comment",
        title: "Комментарий",
        body: "НЕ-ЗАГРУЖАТЬ-ЖУРНАЛ",
        createdBy: "tester",
        createdAt: task.createdAt,
      });
      const originalParse = JSON.parse;
      const parsed: string[] = [];
      const parse = spyOn(JSON, "parse").mockImplementation((value, reviver) => {
        parsed.push(value);
        return originalParse(value, reviver);
      });
      const queries = spyOn(Database.prototype, "query");
      try {
        const result = db.getManySummaries([
          task.id,
          "missing",
          document.id,
          task.id,
          document.key,
        ]);

        const taskSummary = {
          id: task.id,
          kind: "task",
          key: task.key,
          revision: 1,
          title: "Задача",
          state: "review",
          active: undefined,
        } as const;
        expect(result).toEqual([
          taskSummary,
          null,
          {
            id: document.id,
            kind: "document",
            key: document.key,
            revision: 1,
            title: "Документ",
            state: "active",
            active: undefined,
          },
          taskSummary,
          null,
        ]);
        expect(parsed.some((value) => value.includes("НЕ-ЗАГРУЖАТЬ"))).toBe(false);
        expect(queries).toHaveBeenCalledTimes(1);
        // Отсутствие JSON.parse тела не доказывает узкую SQL-проекцию: проверяем выбранные столбцы.
        const columns = queries.mock.results
          .filter((result) => result.type === "return")
          .flatMap((result) => result.value.columnNames);
        expect(columns.toSorted()).toEqual([
          "active",
          "id",
          "key",
          "kind",
          "revision",
          "state",
          "title",
        ]);
      } finally {
        queries.mockRestore();
        parse.mockRestore();
      }
    } finally {
      fixture.close();
    }
  });

  test.each(invalidFields)(
    "$name сохраняется для предметной диагностики Core",
    ({ data, expected }) => {
      const fixture = new ProjectDatabaseFixture("read-summary-invalid");
      try {
        const db = fixture.create();
        const document = { ...createDocument(), data };
        db.insert(document);

        const result = db.getManySummaries([document.id]);

        expect(result).toEqual([
          { id: document.id, kind: "document", key: document.key, revision: 1, ...expected },
        ]);
      } finally {
        fixture.close();
      }
    },
  );

  test("SQL-проекция различает boolean активности и повреждённое число", () => {
    const fixture = new ProjectDatabaseFixture("read-summary-active");
    try {
      const db = fixture.create();
      const first = {
        ...createDocument("IMPL-1"),
        kind: "implementation" as const,
        data: { title: "Снятая", status: "partial", active: false },
      };
      const second = {
        ...createDocument("IMPL-2"),
        kind: "implementation" as const,
        data: { title: "Повреждённая", status: "none", active: 0 },
      };
      db.insert(first);
      db.insert(second);

      const result = db.getManySummaries([first.id, second.id]);

      expect(result.map((record) => record?.active)).toEqual([false, 0]);
    } finally {
      fixture.close();
    }
  });
});
