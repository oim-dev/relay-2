import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import type { KnowledgeRecord } from "@relay/contracts";
import type { ProjectDatabase } from "../../src/database/project-database";
import {
  createDocument,
  createTask,
  expectRelayError,
  ProjectDatabaseFixture,
} from "./helpers/project-database-fixture";

const invalidFields = [
  {
    name: "явный null заголовка",
    data: { name: null },
  },
  {
    name: "объект вместо заголовка",
    data: { name: { bad: true } },
  },
] as const;

/**
 * Сохраняет снятую реализацию с настоящими приложением, доской и функциональностью.
 * Связанные записи создаются одной транзакцией; участие приложения намеренно пусто.
 */
function createInactiveImplementation(db: ProjectDatabase): KnowledgeRecord<"implementation"> {
  const applicationId = crypto.randomUUID();
  const boardId = crypto.randomUUID();
  const feature: KnowledgeRecord<"feature"> = {
    ...createDocument("FEATURE-1"),
    kind: "feature",
    data: { name: "Функциональность", summary: "", description: "" },
  };
  const application: KnowledgeRecord<"application"> = {
    ...createDocument("APP-1"),
    id: applicationId,
    kind: "application",
    data: {
      name: "Приложение",
      summary: "",
      description: "",
      slug: "application",
      prefix: "APP",
      type: "internal",
      boardId,
      implementationIds: [],
    },
  };
  const board: KnowledgeRecord<"board"> = {
    ...createDocument("BOARD-APP"),
    id: boardId,
    kind: "board",
    data: { name: "Доска приложения", slug: "application", prefix: "APP", applicationId },
  };
  const implementation: KnowledgeRecord<"implementation"> = {
    ...createDocument("IMPL-1"),
    kind: "implementation",
    data: {
      title: "Снятая",
      description: "",
      status: "partial",
      active: false,
      applicationId,
      featureId: feature.id,
      targetKind: "feature",
      targetId: feature.id,
    },
  };
  db.transaction(() => {
    db.insert(feature);
    db.insert(application);
    db.insert(board);
    db.insert(implementation);
  });
  return implementation;
}

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
      const document = createDocument("DOC-1", {
        name: "Документ",
        documentStatus: "active",
        body: "НЕ-ЗАГРУЖАТЬ-ТЕЛО",
      });
      const task = createTask(db, "TASK-1", {
        title: "Задача",
        column: "review",
        description: "НЕ-ЗАГРУЖАТЬ-ОПИСАНИЕ",
        acceptanceCriteria: [
          {
            id: "criterion",
            title: "НЕ-ЗАГРУЖАТЬ-КРИТЕРИЙ",
            summary: "",
            description: "",
            completed: false,
            completedAt: null,
            completedBy: null,
          },
        ],
      });
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
    "$name отклоняется до записи без повреждения кратких чтений",
    ({ data }) => {
      const fixture = new ProjectDatabaseFixture("read-summary-invalid");
      try {
        const db = fixture.create();
        const document = createDocument();
        db.insert(document);
        const generation = db.getGeneration();

        expectRelayError(
          () => db.update({ ...document, revision: 2, data: { ...document.data, ...data } }, 1),
          "CORRUPT_DATA",
        );

        expect(db.get(document.id)).toEqual(document);
        expect(db.getGeneration()).toBe(generation);
        expect(db.getManySummaries([document.id])).toEqual([
          {
            id: document.id,
            kind: "document",
            key: document.key,
            revision: 1,
            title: "Документ",
            state: "draft",
            active: undefined,
          },
        ]);
      } finally {
        fixture.close();
      }
    },
  );

  test("SQL-проекция сохраняет false активности, а числовая подмена отклоняется до записи", () => {
    const fixture = new ProjectDatabaseFixture("read-summary-active");
    try {
      const db = fixture.create();
      const implementation = createInactiveImplementation(db);
      const generation = db.getGeneration();

      const result = db.getManySummaries([implementation.id]);
      expectRelayError(
        () =>
          db.update(
            {
              ...implementation,
              revision: 2,
              data: { ...implementation.data, active: 0 },
            },
            1,
          ),
        "CORRUPT_DATA",
      );

      expect(result).toEqual([
        {
          id: implementation.id,
          key: implementation.key,
          kind: "implementation",
          revision: 1,
          title: "Снятая",
          state: "partial",
          active: false,
        },
      ]);
      expect(db.get(implementation.id)).toEqual(implementation);
      expect(db.getGeneration()).toBe(generation);
    } finally {
      fixture.close();
    }
  });
});
