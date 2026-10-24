import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import type { EntityRecord, TaskCriterion } from "@relay/contracts";
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
  /* Восстановление методов statements после наблюдения, включая отказ утверждения. */
  private readonly restoreStatements: (() => void)[] = [];

  /**
   * Устанавливает временное наблюдение, не открывая дополнительных соединений и не читая данных.
   */
  constructor() {
    const originalQuery = Database.prototype.query;
    const owners = this.partOwners;
    const keys = this.partKeys;
    const restoreStatements = this.restoreStatements;
    this.query = spyOn(Database.prototype, "query").mockImplementation(trackedQuery);

    /**
     * Сохраняет generic-контракт драйвера и наблюдает только statements с primary component rows.
     */
    function trackedQuery<Result, Params extends SQLQueryBindings | SQLQueryBindings[]>(
      this: Database,
      sql: string,
    ): ReturnType<typeof originalQuery<Result, Params>> {
      const statement = (originalQuery<Result, Params>).call(this, sql);
      if (!statement.columnNames.includes("owner_id")) {
        return statement;
      }
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
    const target = { ...createDocument("LINKED"), data: { title: "НЕ-ЧИТАТЬ-ЦЕЛЬ-СВЯЗИ" } };
    db.insert(target);
    const first = {
      ...createDocument("DOC-A"),
      data: {
        ownerId: "42",
        title: "Первый",
        relations: [
          {
            target: { kind: "document", id: target.id },
            type: "references",
            description: "Первая выбранная часть",
          },
        ],
      },
    };
    const second = {
      ...createDocument("DOC-Z"),
      data: {
        ownerId: "42",
        title: "Второй",
        relations: [
          {
            target: { kind: "document", id: target.id },
            type: "references",
            description: "Вторая выбранная часть",
          },
        ],
      },
    };
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
        data: {
          ...data,
          title: "НЕ-ЧИТАТЬ-ЧУЖОЕ-СОДЕРЖАНИЕ",
          relations: [
            {
              target: { kind: "document", id: target.id },
              type: "references",
              description: "НЕ-ЧИТАТЬ-ЧУЖУЮ-ЧАСТЬ",
            },
          ],
        },
      });
    }
    db.insert({
      ...createDocument("FEATURE-1"),
      kind: "feature",
      data: { ownerId: "42", title: "НЕ-ЧИТАТЬ-ДРУГОЙ-ВИД" },
    });
    db.insert(first);
    const reads = new SelectionReads();
    const decoder = spyOn(JSON, "parse");
    try {
      const selected = db.listByField("document", "ownerId", "42");

      expect(selected).toEqual([first, second]);
      expect(reads.query).toHaveBeenCalledTimes(2);
      expect(reads.partOwners).toHaveLength(1);
      expect([...new Set(reads.partOwners[0])].sort()).toEqual([first.id, second.id].sort());
      expect(decoder.mock.calls.some(([text]) => text.includes("НЕ-ЧИТАТЬ"))).toBe(false);
    } finally {
      decoder.mockRestore();
      reads.restore();
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
      data: {
        ownerId: "selected",
        title: "Нужная задача",
        acceptanceCriteria: [selectionCriterion("selected-criterion", "Часть выбранной задачи")],
      },
    };
    const excluded: EntityRecord = {
      ...createDocument("TASK-2"),
      kind: "task",
      data: {
        ownerId: "other",
        title: "НЕ-ЧИТАТЬ-ЗАДАЧУ",
        acceptanceCriteria: [selectionCriterion("excluded-criterion", "НЕ-ЧИТАТЬ-ЧАСТЬ-ЗАДАЧИ")],
      },
    };
    db.insert(selected);
    db.insert(excluded);
    const comment = createComment("Полный текст выбранного комментария");
    db.appendTaskComment(selected.id, comment);
    db.appendTaskComment(excluded.id, createComment("НЕ-ЧИТАТЬ-ЖУРНАЛ"));
    const reads = new SelectionReads();
    const decoder = spyOn(JSON, "parse");
    try {
      const records = db.listByField("task", "ownerId", "selected");

      expect(records).toEqual([{ ...selected, data: { ...selected.data, comments: [comment] } }]);
      expect(reads.query).toHaveBeenCalledTimes(2);
      expect(reads.partOwners).toHaveLength(1);
      expect([...new Set(reads.partOwners[0])]).toEqual([selected.id]);
      expect(decoder.mock.calls.some(([text]) => text.includes("НЕ-ЧИТАТЬ"))).toBe(false);
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
      const taskBase = createDocument("TASK-1");
      const task: EntityRecord = {
        ...taskBase,
        kind: "task",
        data: {
          ...taskBase.data,
          acceptanceCriteria: [selectionCriterion("criterion", "Часть выбранной задачи")],
        },
      };
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
      db.insert(document);
      db.insert(task);
      const renamed = db.rename(document.id, "DOC-NEW", 1, "editor");
      const first = createComment("Первое сообщение");
      const second = { ...createComment("Второе сообщение"), createdAt: "2000-01-01" };
      db.appendTaskComment(task.id, first);
      db.appendTaskComment(task.id, second);
      db.insert({
        ...createDocument("UNRELATED"),
        data: {
          title: "НЕ-ЧИТАТЬ-ДРУГОЙ-ID",
          relations: [
            {
              target: { kind: "task", id: task.id },
              type: "documents",
              description: "НЕ-ЧИТАТЬ-ДРУГИЕ-PARTS",
            },
          ],
        },
      });
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

describe("Узкие идентичности состава с ревизиями", () => {
  test("строковый фильтр возвращает только четыре SQL-столбца без содержания и журнала", () => {
    const field = 'owner.id"[0]';
    const value = "owner' OR 1=1 --";
    const later: EntityRecord = {
      ...createDocument("TASK-Z"),
      kind: "task",
      data: { [field]: value, description: "НЕ-ЗАГРУЖАТЬ-ОПИСАНИЕ" },
    };
    const initial: EntityRecord = {
      ...createDocument("TASK-OLD"),
      kind: "task",
      data: { [field]: value, description: "НЕ-ЗАГРУЖАТЬ-ДРУГОЕ-ОПИСАНИЕ" },
    };
    db.insert(later);
    db.insert(initial);
    db.insert({ ...createDocument("DOC-1"), data: { [field]: value } });
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
