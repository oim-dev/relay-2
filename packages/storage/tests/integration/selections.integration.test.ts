import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import type { TaskCriterion } from "@relay/contracts";
import type { ProjectDatabase } from "../../src/database/project-database";
import {
  ProjectDatabaseFixture,
  createComment,
  createDocument,
  createTask,
  expectRelayError,
} from "./helpers/project-database-fixture";

const batchMethods = ["getMany", "getManyIdentities"] as const;
const literalFields = [
  { name: "имя с точкой", field: "summary.value", value: "owner" },
  { name: "пустое имя и значение", field: "", value: "" },
  {
    name: "кавычки и синтаксис SQL",
    field: "summary[0].\"value' OR 1=1 --",
    value: "value' OR 1=1 --",
  },
] as const;
const invalidFieldData = [
  { name: "число вместо строкового поля", data: { summary: 42 } },
  { name: "boolean вместо строкового поля", data: { summary: true } },
  { name: "null вместо обязательной строки", data: { summary: null } },
  { name: "массив вместо строкового поля", data: { summary: ["42"] } },
  { name: "объект вместо строкового поля", data: { summary: { value: "42" } } },
  { name: "неизвестное вложенное поле", data: { nested: { summary: "42" } } },
] as const;
const nonStringFields = [
  { field: "pinned", value: "false" },
  { field: "sectionId", value: "null" },
  { field: "relations", value: "[]" },
] as const;
let fixture: ProjectDatabaseFixture;
let db: ProjectDatabase;

/**
 * Наблюдает настоящую SQLite→JS границу: число запросов и owners/PK реально возвращённых parts.
 * Значения и SQL не подменяет. restore возвращает также методы кешированных statements.
 */
class SelectionReads {
  /* Все SQL-вызовы проверяемого чтения, включая один пакет гидратации. */
  readonly query: Mock<Database["query"]>;
  /* Owners реально загруженных primary rows, по одному массиву на SQL-пакет. */
  readonly partOwners: string[][] = [];
  /* Scoped PK реально загруженных rows для проверки отсутствия повторной загрузки при repeated IDs. */
  readonly partKeys: string[][] = [];
  /* Настоящие SQL rows до отбора или декодирования в TypeScript. */
  readonly rows: unknown[] = [];
  /* Восстановление методов statements после наблюдения, включая отказ утверждения. */
  private readonly restoreStatements: (() => void)[] = [];

  /**
   * Устанавливает временное наблюдение, не открывая дополнительных соединений и не читая данных.
   */
  constructor() {
    const originalQuery = Database.prototype.query;
    const owners = this.partOwners;
    const keys = this.partKeys;
    const selectedRows = this.rows;
    const restoreStatements = this.restoreStatements;
    this.query = spyOn(Database.prototype, "query").mockImplementation(trackedQuery);

    /**
     * Сохраняет generic-контракт драйвера и наблюдает rows до обработки в приложении.
     */
    function trackedQuery<Result, Params extends SQLQueryBindings | SQLQueryBindings[]>(
      this: Database,
      sql: string,
    ): ReturnType<typeof originalQuery<Result, Params>> {
      const statement = (originalQuery<Result, Params>).call(this, sql);
      const componentRows = statement.columnNames.includes("owner_id");
      const originalAll = statement.all;
      statement.all = trackedAll;
      restoreStatements.push(() => {
        statement.all = originalAll;
      });
      return statement;

      /**
       * Запоминает IDs из исходных SQL rows до возможной фильтрации или JSON-декодирования приложения.
       */
      function trackedAll(...params: Parameters<typeof originalAll>): Result[] {
        const rows = originalAll.apply(statement, params);
        selectedRows.push(...rows);
        if (!componentRows) {
          return rows;
        }
        const ownerBatch: string[] = [];
        const keyBatch: string[] = [];
        for (const row of rows) {
          if (
            row === null ||
            typeof row !== "object" ||
            !("owner_id" in row) ||
            typeof row.owner_id !== "string" ||
            !("kind" in row) ||
            typeof row.kind !== "string" ||
            !("id" in row) ||
            typeof row.id !== "string"
          ) {
            throw new Error("Наблюдение ожидало primary component row");
          }
          ownerBatch.push(row.owner_id);
          keyBatch.push(JSON.stringify([row.owner_id, row.kind, row.id]));
        }
        owners.push(ownerBatch);
        keys.push(keyBatch);
        return rows;
      }
    }
  }

  /**
   * Освобождает все временные observers в обратном порядке; данные БД не изменяет.
   */
  restore(): void {
    for (const restore of this.restoreStatements.toReversed()) {
      restore();
    }
    this.query.mockRestore();
  }
}

/**
 * Создаёт минимальный настоящий criterion payload, чтобы проверять границу гидратации тела части.
 */
function selectionCriterion(id: string, description: string): TaskCriterion {
  return {
    id,
    title: id,
    summary: "",
    description,
    completed: false,
    completedAt: null,
    completedBy: null,
  };
}

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("selections");
  db = fixture.create();
});

afterEach(() => {
  fixture.close();
});

describe("Выборки по строковому полю содержания", () => {
  test("owners и один пакет parts отбирают точные строки нужного вида и сохраняют порядок ключей", () => {
    const target = createDocument("LINKED", { name: "НЕ-ЧИТАТЬ-ЦЕЛЬ-СВЯЗИ" });
    db.insert(target);
    const first = createDocument("DOC-A", {
      summary: "42",
      name: "Первый",
      relations: [
        {
          target: { kind: "document", id: target.id },
          type: "references",
          description: "Первая выбранная часть",
        },
      ],
    });
    const second = createDocument("DOC-Z", {
      summary: "42",
      name: "Второй",
      relations: [
        {
          target: { kind: "document", id: target.id },
          type: "references",
          description: "Вторая выбранная часть",
        },
      ],
    });
    // Совпадение в другом поле, подстрока и чужое значение не должны попасть в фильтр.
    const excludedData = [
      { summary: "142" },
      { summary: "" },
      { summary: "other" },
      { name: "42" },
    ];
    db.insert(second);
    for (const [index, data] of excludedData.entries()) {
      db.insert(
        createDocument(`OTHER-${index}`, {
          name: "НЕ-ЧИТАТЬ-ЧУЖОЕ-СОДЕРЖАНИЕ",
          body: "НЕ-ЧИТАТЬ-ЧУЖОЕ-ТЕЛО",
          ...data,
          relations: [
            {
              target: { kind: "document", id: target.id },
              type: "references",
              description: "НЕ-ЧИТАТЬ-ЧУЖУЮ-ЧАСТЬ",
            },
          ],
        }),
      );
    }
    db.insert({
      ...createDocument("FEATURE-1"),
      kind: "feature",
      data: { summary: "42", name: "НЕ-ЧИТАТЬ-ДРУГОЙ-ВИД", description: "" },
    });
    db.insert(first);
    const reads = new SelectionReads();
    const decoder = spyOn(JSON, "parse");
    try {
      const selected = db.listByField("document", "summary", "42");

      expect(selected).toEqual([first, second]);
      expect(reads.query).toHaveBeenCalledTimes(2);
      expect(reads.partOwners).toHaveLength(1);
      expect([...new Set(reads.partOwners[0])].sort()).toEqual([first.id, second.id].sort());
      expect(decoder.mock.calls.some(([text]) => text.includes("НЕ-ЧИТАТЬ"))).toBe(false);
      expect(JSON.stringify(reads.rows)).not.toContain("НЕ-ЧИТАТЬ");
    } finally {
      decoder.mockRestore();
      reads.restore();
    }
  });

  test.each(literalFields)(
    "$name не интерпретируется как путь или SQL-выражение",
    ({ field, value }) => {
      const document = createDocument("DOC-1", { summary: value });
      db.insert(document);

      const records = db.listByField("document", field, value);
      const missing = db.listByField("document", field, `${value}-missing`);

      expect(records).toEqual([]);
      expect(missing).toEqual([]);
      expect(db.listByField("document", "summary", value)).toEqual([document]);
    },
  );

  test.each(invalidFieldData)("$name отклоняется без записи вместо JSON fallback", ({ data }) => {
    const document = createDocument();
    const generation = db.getGeneration();

    expectRelayError(
      () => db.insert({ ...document, data: { ...document.data, ...data } }),
      "CORRUPT_DATA",
    );

    expect(db.get(document.id)).toBeUndefined();
    expect(db.get(document.key)).toBeUndefined();
    expect(db.getGeneration()).toBe(generation);
  });

  test.each(nonStringFields)("$field не приводится к строке при фильтрации", ({ field, value }) => {
    db.insert(createDocument());

    expect(db.listByField("document", field, value)).toEqual([]);
    expect(db.listIdentitiesByField("document", field, value)).toEqual([]);
  });

  test("фильтр задачи возвращает весь журнал только выбранного владельца", () => {
    const selected = createTask(db, "TASK-1", {
      column: "review",
      title: "Нужная задача",
      acceptanceCriteria: [selectionCriterion("selected-criterion", "Часть выбранной задачи")],
    });
    const excluded = createTask(db, "TASK-2", {
      column: "ready",
      title: "НЕ-ЧИТАТЬ-ЗАДАЧУ",
      acceptanceCriteria: [selectionCriterion("excluded-criterion", "НЕ-ЧИТАТЬ-ЧАСТЬ-ЗАДАЧИ")],
    });
    db.insert(selected);
    db.insert(excluded);
    const comment = createComment("Полный текст выбранного комментария");
    db.appendTaskComment(selected.id, comment);
    db.appendTaskComment(excluded.id, createComment("НЕ-ЧИТАТЬ-ЖУРНАЛ"));
    const reads = new SelectionReads();
    const decoder = spyOn(JSON, "parse");
    try {
      const records = db.listByField("task", "column", "review");

      expect(records).toEqual([{ ...selected, data: { ...selected.data, comments: [comment] } }]);
      expect(reads.query).toHaveBeenCalledTimes(2);
      expect(reads.partOwners).toHaveLength(1);
      expect([...new Set(reads.partOwners[0])]).toEqual([selected.id]);
      expect(decoder.mock.calls.some(([text]) => text.includes("НЕ-ЧИТАТЬ"))).toBe(false);
      expect(JSON.stringify(reads.rows)).not.toContain("НЕ-ЧИТАТЬ");
    } finally {
      decoder.mockRestore();
      reads.restore();
    }
  });
});

describe("Пакетные чтения постоянных ID", () => {
  test.each(batchMethods)(
    "%s сохраняет порядок и повторы, пропуская отсутствующие ID, ключи и алиасы",
    (method) => {
      const task = createTask(db, "TASK-1", {
        acceptanceCriteria: [selectionCriterion("criterion", "Часть выбранной задачи")],
      });
      const documentBase = createDocument("DOC-OLD");
      const document = {
        ...documentBase,
        id: "document' OR 1=1 --",
        data: {
          ...documentBase.data,
          relations: [
            {
              target: { kind: "task", id: task.id },
              type: "documents",
              description: "Часть выбранного документа",
            },
          ],
        },
      };
      db.insert(task);
      db.insert(document);
      const renamed = db.rename(document.id, "DOC-NEW", 1, "editor");
      const first = createComment("Первое сообщение");
      const second = { ...createComment("Второе сообщение"), createdAt: "2000-01-01" };
      db.appendTaskComment(task.id, first);
      db.appendTaskComment(task.id, second);
      db.insert(
        createDocument("UNRELATED", {
          name: "НЕ-ЧИТАТЬ-ДРУГОЙ-ID",
          relations: [
            {
              target: { kind: "task", id: task.id },
              type: "documents",
              description: "НЕ-ЧИТАТЬ-ДРУГИЕ-PARTS",
            },
          ],
        }),
      );
      const ids = [task.id, "missing", document.key, renamed.key, document.id, task.id] as const;
      const reads = new SelectionReads();
      const decoder = spyOn(JSON, "parse");
      try {
        const records = db[method](ids);

        if (method === "getMany") {
          const expectedTask = { ...task, data: { ...task.data, comments: [first, second] } };
          expect(records).toEqual([expectedTask, renamed, expectedTask]);
          expect(reads.query).toHaveBeenCalledTimes(2);
          expect(reads.partOwners).toHaveLength(1);
          expect([...new Set(reads.partOwners[0])].sort()).toEqual([task.id, document.id].sort());
          expect(reads.partKeys).toHaveLength(1);
          for (const keys of reads.partKeys) {
            expect(new Set(keys).size).toBe(keys.length);
          }
          expect(decoder.mock.calls.some(([text]) => text.includes("НЕ-ЧИТАТЬ"))).toBe(false);
          expect(JSON.stringify(reads.rows)).not.toContain("НЕ-ЧИТАТЬ");
        } else {
          expect(records).toEqual([
            { id: task.id, kind: "task", key: task.key },
            { id: document.id, kind: "document", key: "DOC-NEW" },
            { id: task.id, kind: "task", key: task.key },
          ]);
          expect(decoder).not.toHaveBeenCalled();
          expect(reads.query).toHaveBeenCalledTimes(1);
          expect(reads.partOwners).toEqual([]);
        }
      } finally {
        decoder.mockRestore();
        reads.restore();
      }
    },
  );

  test.each(batchMethods)("%s исключает другой вид до декодирования карточек", (method) => {
    const selected = createDocument();
    const otherKind = createTask(db, "TASK-1", {
      description: "НЕ-ЧИТАТЬ-ДРУГОЙ-ВИД",
      acceptanceCriteria: [selectionCriterion("criterion", "НЕ-ЧИТАТЬ-ДРУГУЮ-ЧАСТЬ")],
    });
    db.insert(selected);
    db.insert(otherKind);
    db.appendTaskComment(otherKind.id, createComment("НЕ-ЧИТАТЬ-ДРУГОЙ-ЖУРНАЛ"));
    fixture.withRaw((raw) => {
      // Обходим CHECK намеренно: чтение другого вида не должно затрагивать повреждённый text carrier.
      raw.exec("PRAGMA ignore_check_constraints = ON");
      raw
        .query("UPDATE tasks SET description = NULL, description_json = 'не JSON' WHERE id = ?")
        .run(otherKind.id);
    });
    const reads = new SelectionReads();
    const decoder = spyOn(JSON, "parse");
    try {
      const records = db[method]([otherKind.id, selected.id, "missing"], "document");

      expect(records).toEqual(
        method === "getMany"
          ? [selected]
          : [{ id: selected.id, kind: "document", key: selected.key }],
      );
      expect(JSON.stringify(reads.rows)).not.toContain("НЕ-ЧИТАТЬ");
      expect(reads.partOwners.flat()).not.toContain(otherKind.id);
      expect(decoder.mock.calls.some(([text]) => text.includes("НЕ-ЧИТАТЬ"))).toBe(false);
    } finally {
      decoder.mockRestore();
      reads.restore();
    }
    expectRelayError(() => db.getMany([otherKind.id], "task"), "STORAGE_ERROR");
  });

  test("идентичности доступны без чтения и декодирования повреждённого содержания", () => {
    const document = createDocument("DOC-1", { body: "НЕ-ЧИТАТЬ-ТЕЛО-ДОКУМЕНТА" });
    db.insert(document);
    fixture.withRaw((raw) => {
      // Проверяем техническое повреждение файла, которое штатная typed-запись не допускает.
      raw.exec("PRAGMA ignore_check_constraints = ON");
      raw
        .query("UPDATE documents SET body = NULL, body_json = 'не JSON' WHERE id = ?")
        .run(document.id);
    });
    const reads = new SelectionReads();
    const decoder = spyOn(JSON, "parse");
    try {
      const identities = db.getManyIdentities([document.id], "document");

      expect(identities).toEqual([{ id: document.id, kind: "document", key: document.key }]);
      expect(decoder).not.toHaveBeenCalled();
      expect(reads.rows).toEqual(identities);
      expect(reads.partOwners).toEqual([]);
    } finally {
      decoder.mockRestore();
      reads.restore();
    }
    expectRelayError(() => db.getMany([document.id]), "STORAGE_ERROR");
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
    expectRelayError(() => db.listByField("document", "summary", "owner"), "DATABASE_CLOSED");
  });
});

describe("Узкие идентичности состава с ревизиями", () => {
  test("строковый фильтр возвращает только четыре SQL-столбца без содержания и журнала", () => {
    const field = "title";
    const value = "owner' OR 1=1 --";
    const later = createTask(db, "TASK-Z", { title: value, description: "НЕ-ЗАГРУЖАТЬ-ОПИСАНИЕ" });
    const initial = createTask(db, "TASK-OLD", {
      title: value,
      description: "НЕ-ЗАГРУЖАТЬ-ДРУГОЕ-ОПИСАНИЕ",
    });
    db.insert(later);
    db.insert(initial);
    db.insert(createDocument("DOC-1", { name: value }));
    const renamed = db.rename(initial.id, "TASK-A", initial.revision, "editor");
    db.appendTaskComment(initial.id, createComment("НЕ-ЗАГРУЖАТЬ-ЖУРНАЛ"));
    const queries = spyOn(Database.prototype, "query");
    const parse = spyOn(JSON, "parse");
    try {
      const result = db.listIdentitiesByField("task", field, value);

      expect(result).toEqual([
        { id: initial.id, kind: "task", key: "TASK-A", revision: renamed.revision },
        { id: later.id, kind: "task", key: "TASK-Z", revision: later.revision },
      ]);
      expect(queries).toHaveBeenCalledTimes(1);
      expect(parse).not.toHaveBeenCalled();
      // Граница SQLite → TypeScript проверяется по настоящему prepared statement,
      // чтобы отбрасывание уже прочитанных текстов не прошло как узкая проекция.
      const columns = queries.mock.results
        .filter((result) => result.type === "return")
        .flatMap((result) => result.value.columnNames);
      expect(columns.toSorted()).toEqual(["id", "key", "kind", "revision"]);
    } finally {
      parse.mockRestore();
      queries.mockRestore();
    }
    expect(db.listIdentitiesByField("task", field, "missing")).toEqual([]);
  });
});
