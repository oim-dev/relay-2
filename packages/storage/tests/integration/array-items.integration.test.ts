import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { HistoryRun, HistorySession } from "@relay/contracts";
import type { ProjectDatabase } from "../../src/database/project-database";
import {
  ProjectDatabaseFixture,
  createDocument,
  createTask,
  expectRelayError,
} from "./helpers/project-database-fixture";

const invalidData = [
  { name: "вложенный массив вместо верхнеуровневого", data: { nested: { runs: [{ id: "42" }] } } },
  { name: "null вместо массива", data: { runs: null } },
  { name: "число вместо массива", data: { runs: 42 } },
  { name: "boolean вместо массива", data: { runs: true } },
  { name: "не-JSON строка вместо массива", data: { runs: "не JSON" } },
  { name: "JSON-строка вместо массива", data: { runs: '[{"id":"42"}]' } },
  { name: "объект вместо массива", data: { runs: { item: { id: "42" } } } },
  { name: "null вместо участия", data: { runs: [null] } },
  { name: "boolean вместо участия", data: { runs: [false] } },
  { name: "число вместо участия", data: { runs: [42] } },
  { name: "не-JSON строка вместо участия", data: { runs: ["не JSON"] } },
  { name: "JSON-строка вместо участия", data: { runs: ['{"id":"42"}'] } },
  { name: "массив вместо участия", data: { runs: [[createRun("42")]] } },
  { name: "отсутствующее поле объекта", data: { runs: [{ ...createRun("42"), id: undefined }] } },
  {
    name: "вложенное поле объекта",
    data: { runs: [{ ...createRun("42"), id: undefined, nested: { id: "42" } }] },
  },
  { name: "число вместо строки поля", data: { runs: [{ ...createRun("42"), id: 42 }] } },
  { name: "null вместо ID участия", data: { runs: [{ ...createRun("42"), id: null }] } },
  { name: "boolean вместо ID участия", data: { runs: [{ ...createRun("42"), id: false }] } },
  { name: "массив вместо ID участия", data: { runs: [{ ...createRun("42"), id: ["42"] }] } },
  {
    name: "объект вместо ID участия",
    data: { runs: [{ ...createRun("42"), id: { value: "42" } }] },
  },
] as const;
const literalFields = [
  { name: "точки в именах", arrayField: "runs.items", itemField: "run.id", value: "run-id" },
  { name: "пустые имена и значение", arrayField: "", itemField: "", value: "" },
  {
    name: "кавычки и синтаксис SQL",
    arrayField: "runs[0].\"items' OR 1=1 --",
    itemField: "run[0].\"id' OR 1=1 --",
    value: "value' OR 1=1 --",
  },
] as const;
let fixture: ProjectDatabaseFixture;
let db: ProjectDatabase;

/**
 * Формирует полное участие; сохранение и связь с владельцем остаются явными действиями теста.
 */
function createRun(id: string, fields: Readonly<Partial<HistoryRun>> = {}): HistoryRun {
  return {
    id,
    key: `RUN-${id}`,
    actor: "author",
    state: "active",
    reason: "НЕ-ЗАГРУЖАТЬ-ПРИЧИНУ",
    operator: null,
    client: null,
    sourceSessionId: null,
    predecessorRunId: null,
    startedAt: "2026-10-24T01:00:00.000Z",
    endedAt: null,
    endReason: null,
    ...fields,
  };
}

/**
 * Формирует сессию с полной предметной формой без сохранения в БД.
 * Активное участие выбирается из явно переданного состава; пустая сессия приостановлена.
 */
function createSession(runs: readonly HistoryRun[] = []): HistorySession {
  const currentRunId = runs.find((run) => run.state === "active")?.id ?? null;
  return {
    ...createDocument("SESSION-1"),
    kind: "work-session",
    data: {
      title: "НЕ-ЗАГРУЖАТЬ-СОДЕРЖАНИЕ",
      description: null,
      status: currentRunId === null ? "paused" : "open",
      currentRunId,
      runs: [...runs],
      parentSessionId: null,
      originCheckpointId: null,
      createdByRunId: null,
      result: null,
      closedAt: null,
    },
  };
}

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("array-items");
  db = fixture.create();
});

afterEach(() => {
  fixture.close();
});

describe("Наличие элемента типизированной коллекции", () => {
  test("находит точное строковое поле среди нескольких участий одним запросом без декодирования", () => {
    db.insert(
      createSession([
        createRun("previous", {
          actor: "other",
          state: "transferred",
          endedAt: "2026-10-24T02:00:00.000Z",
          endReason: "Передача ответственности",
        }),
        createRun("current", { predecessorRunId: "previous" }),
      ]),
    );
    const query = spyOn(Database.prototype, "query");
    const decoder = spyOn(JSON, "parse");
    try {
      const exists = db.hasArrayItemByField("work-session", "runs", "actor", "author");

      expect(exists).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      expect(decoder).not.toHaveBeenCalled();
      expect(
        query.mock.results.flatMap((result) =>
          result.type === "return" ? result.value.columnNames : [],
        ),
      ).toEqual(["1"]);
    } finally {
      decoder.mockRestore();
      query.mockRestore();
    }
  });

  test("находит normalized run и отвергает отсутствующий тем же узким одиночным SQL", () => {
    const session = createSession([createRun("normalized-run")]);
    db.insert(session);
    fixture.withRaw((raw) => {
      expect(
        raw
          .query("SELECT owner_id, id FROM session_runs WHERE owner_id=? AND deleted=0")
          .get(session.id),
      ).toEqual({ owner_id: session.id, id: "normalized-run" });
    });
    const query = spyOn(Database.prototype, "query");
    const decoder = spyOn(JSON, "parse");
    try {
      expect(db.hasArrayItemByField("work-session", "runs", "id", "normalized-run")).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      expect(decoder).not.toHaveBeenCalled();
      expect(
        query.mock.results.flatMap((result) =>
          result.type === "return" ? result.value.columnNames : [],
        ),
      ).toEqual(["1"]);
      query.mockClear();

      expect(db.hasArrayItemByField("work-session", "runs", "id", "missing-run")).toBe(false);
      expect(query).toHaveBeenCalledTimes(1);
      expect(decoder).not.toHaveBeenCalled();
    } finally {
      decoder.mockRestore();
      query.mockRestore();
    }
  });

  test.each(invalidData)("$name отклоняется до сохранения владельца и частей", ({ data }) => {
    const session = createSession();
    const generation = db.getGeneration();

    expectRelayError(
      () => db.insert({ ...session, data: { ...session.data, ...data } }),
      "CORRUPT_DATA",
    );

    expect(db.get(session.id)).toBeUndefined();
    expect(db.get(session.key)).toBeUndefined();
    expect(db.getComponents([session.id])).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
    expect(db.hasArrayItemByField("work-session", "runs", "id", "42")).toBe(false);
  });

  test("пустой состав и подстрока ID не считаются точным совпадением", () => {
    const session = createSession();
    db.insert(session);
    expect(db.hasArrayItemByField("work-session", "runs", "id", "42")).toBe(false);

    const run = createRun("142");
    db.update(
      {
        ...session,
        revision: 2,
        data: { ...session.data, status: "open", currentRunId: run.id, runs: [run] },
      },
      1,
    );

    expect(db.hasArrayItemByField("work-session", "runs", "id", "42")).toBe(false);
    expect(db.hasArrayItemByField("work-session", "runs", "id", "142")).toBe(true);
  });

  test("совпадающее поле другого вида не резервирует значение для выбранного вида", () => {
    db.insert(createSession([createRun("owned")]));
    db.insert(
      createTask(db, "TASK-1", {
        acceptanceCriteria: [
          {
            id: "foreign",
            title: "Чужой состав",
            summary: "",
            description: "",
            completed: false,
            completedAt: null,
            completedBy: null,
          },
        ],
      }),
    );

    const otherKind = db.hasArrayItemByField("work-session", "runs", "id", "foreign");
    const matchingKind = db.hasArrayItemByField("task", "acceptanceCriteria", "id", "foreign");

    expect(otherKind).toBe(false);
    expect(matchingKind).toBe(true);
    expect(db.hasArrayItemByField("task", "runs", "id", "owned")).toBe(false);
  });

  test.each(literalFields)(
    "$name не интерпретируются как пути или SQL",
    ({ arrayField, itemField, value }) => {
      db.insert(createSession([createRun("literal-run", { reason: value })]));

      const matching = db.hasArrayItemByField("work-session", arrayField, itemField, value);
      const missing = db.hasArrayItemByField(
        "work-session",
        arrayField,
        itemField,
        `${value}-missing`,
      );

      expect(matching).toBe(false);
      expect(missing).toBe(false);
      expect(db.hasArrayItemByField("work-session", arrayField, "reason", value)).toBe(false);
      expect(db.hasArrayItemByField("work-session", "runs", itemField, value)).toBe(false);
      expect(db.hasArrayItemByField("work-session", "runs", "reason", value)).toBe(true);
    },
  );

  test("вложенное имя оператора не считается верхнеуровневым полем участия", () => {
    db.insert(
      createSession([
        createRun("operator-run", {
          operator: { name: "Оператор", email: null, source: "explicit" },
        }),
      ]),
    );

    expect(db.hasArrayItemByField("work-session", "runs", "operator.name", "Оператор")).toBe(false);
    expect(db.hasArrayItemByField("work-session", "runs", "name", "Оператор")).toBe(false);
    expect(db.hasArrayItemByField("work-session", "runs", "id", "operator-run")).toBe(true);
  });

  test("внешний snapshot сохраняет результат после записи конкурентного соединения", () => {
    const session = createSession();
    db.insert(session);
    const writer = fixture.open();

    db.snapshot(() => {
      expect(db.hasArrayItemByField("work-session", "runs", "id", "new-run")).toBe(false);
      const run = createRun("new-run");
      writer.update(
        {
          ...session,
          revision: 2,
          data: { ...session.data, status: "open", currentRunId: run.id, runs: [run] },
        },
        1,
      );
      expect(db.hasArrayItemByField("work-session", "runs", "id", "new-run")).toBe(false);
    });

    expect(db.hasArrayItemByField("work-session", "runs", "id", "new-run")).toBe(true);
  });

  test("закрытая база возвращает DATABASE_CLOSED вместо отрицательного совпадения", () => {
    db.close();

    expectRelayError(
      () => db.hasArrayItemByField("work-session", "runs", "id", "run-id"),
      "DATABASE_CLOSED",
    );
  });
});
