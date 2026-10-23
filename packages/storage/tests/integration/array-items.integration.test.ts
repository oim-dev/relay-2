import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { EntityRecord } from "@relay/contracts";
import type { ProjectDatabase } from "../../src/database/project-database";
import {
  ProjectDatabaseFixture,
  createDocument,
  expectRelayError,
} from "./helpers/project-database-fixture";

const unmatchedData = [
  { name: "отсутствующий массив", data: {} },
  { name: "вложенный массив вместо верхнеуровневого", data: { nested: { runs: [{ id: "42" }] } } },
  { name: "null вместо массива", data: { runs: null } },
  { name: "число вместо массива", data: { runs: 42 } },
  { name: "boolean вместо массива", data: { runs: true } },
  { name: "не-JSON строка вместо массива", data: { runs: "не JSON" } },
  { name: "JSON-строка вместо массива", data: { runs: '[{"id":"42"}]' } },
  { name: "объект вместо массива", data: { runs: { item: { id: "42" } } } },
  { name: "пустой массив", data: { runs: [] } },
  {
    name: "скаляры и вложенный массив вместо объектов",
    data: { runs: [null, false, 42, "не JSON", '{"id":"42"}', [{ id: "42" }]] },
  },
  { name: "отсутствующее поле объекта", data: { runs: [{ other: "42" }] } },
  { name: "вложенное поле объекта", data: { runs: [{ nested: { id: "42" } }] } },
  { name: "число вместо строки поля", data: { runs: [{ id: 42 }] } },
  {
    name: "нестроковые формы поля",
    data: { runs: [{ id: null }, { id: false }, { id: ["42"] }, { id: { value: "42" } }] },
  },
  { name: "подстрока вместо точного значения", data: { runs: [{ id: "142" }] } },
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
 * Формирует минимальную техническую сессию для SQL-проверки вложенных данных, не сохраняя её.
 * Предметная валидность истории принадлежит Core; тест задаёт любые допустимые формы JSON.
 */
function createSession(data: Record<string, unknown>): EntityRecord {
  return { ...createDocument("SESSION-1"), kind: "work-session", data };
}

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("array-items");
  db = fixture.create();
});

afterEach(() => {
  fixture.close();
});

describe("Наличие объекта в верхнеуровневом JSON-массиве", () => {
  test("находит точную строку после скалярных элементов одним запросом без декодирования", () => {
    db.insert(
      createSession({
        title: "НЕ-ЗАГРУЖАТЬ-СОДЕРЖАНИЕ",
        runs: ["не JSON", '{"id":"other"}', null, false, 42, [{ id: "other" }], { id: "run-id" }],
      }),
    );
    const query = spyOn(Database.prototype, "query");
    const decoder = spyOn(JSON, "parse");
    try {
      const exists = db.hasArrayItemByField("work-session", "runs", "id", "run-id");

      expect(exists).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      expect(decoder).not.toHaveBeenCalled();
    } finally {
      decoder.mockRestore();
      query.mockRestore();
    }
  });

  test.each(unmatchedData)("$name не совпадает и не вызывает ошибку разбора JSON", ({ data }) => {
    db.insert(createSession(data));

    const exists = db.hasArrayItemByField("work-session", "runs", "id", "42");

    expect(exists).toBe(false);
  });

  test("совпадающее поле другого вида не резервирует значение для выбранного вида", () => {
    db.insert(createSession({ runs: [{ id: "owned" }] }));
    db.insert({ ...createDocument(), data: { runs: [{ id: "foreign" }] } });

    const otherKind = db.hasArrayItemByField("work-session", "runs", "id", "foreign");
    const matchingKind = db.hasArrayItemByField("document", "runs", "id", "foreign");

    expect(otherKind).toBe(false);
    expect(matchingKind).toBe(true);
  });

  test.each(literalFields)("$name сравниваются буквально", ({ arrayField, itemField, value }) => {
    db.insert(createSession({ [arrayField]: [{ [itemField]: value }] }));

    const matching = db.hasArrayItemByField("work-session", arrayField, itemField, value);
    const missing = db.hasArrayItemByField(
      "work-session",
      arrayField,
      itemField,
      `${value}-missing`,
    );

    expect(matching).toBe(true);
    expect(missing).toBe(false);
  });

  test("внешний snapshot сохраняет результат после записи конкурентного соединения", () => {
    const session = createSession({ runs: [] });
    db.insert(session);
    const writer = fixture.open();

    db.snapshot(() => {
      expect(db.hasArrayItemByField("work-session", "runs", "id", "new-run")).toBe(false);
      writer.update({ ...session, revision: 2, data: { runs: [{ id: "new-run" }] } }, 1);
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
