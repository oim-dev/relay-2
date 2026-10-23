import { describe, expect, test } from "bun:test";
import { RelayError } from "@relay/contracts";
import { batchActions } from "./batch-catalog";
import { canonicalBatchJson, parseBatch, prepareBatchInput } from "./batch-input";

const invalidRequests = [
  {
    name: "неизвестная версия",
    input: { version: 2, operations: [{ op: "task.create" }] },
    path: "version",
  },
  { name: "пустой пакет", input: { version: 1, operations: [] }, path: "operations" },
  {
    name: "201 операция",
    input: { version: 1, operations: Array.from({ length: 201 }, () => ({ op: "task.create" })) },
    path: "operations",
  },
  {
    name: "неизвестная операция",
    input: { version: 1, operations: [{ op: "entity.patch" }] },
    path: "operations[0].op",
  },
  {
    name: "неизвестное поле оболочки",
    input: { version: 1, operations: [{ op: "task.create", raw: {} }] },
    path: "operations[0].raw",
  },
  {
    name: "неизвестное предметное поле",
    input: { version: 1, operations: [{ op: "task.create", input: { status: "done" } }] },
    path: "operations[0].input.status",
  },
  {
    name: "повтор as",
    input: {
      version: 1,
      operations: [
        { op: "task.create", as: "task" },
        { op: "task.create", as: "task" },
      ],
    },
    path: "operations[1].as",
  },
  {
    name: "отсутствующий CAS",
    input: {
      version: 1,
      operations: [{ op: "task.update", ref: "PRODUCT-1", input: { title: "Задача" } }],
    },
    path: "operations[0].ifRevision",
  },
  {
    name: "лишний CAS комментария",
    input: {
      version: 1,
      operations: [
        { op: "task.comment.add", ref: "PRODUCT-1", ifRevision: 1, input: { body: "Текст" } },
      ],
    },
    path: "operations[0].ifRevision",
  },
];
const significantJsonChanges = [
  { name: "порядок массива", original: { values: ["a", "b"] }, changed: { values: ["b", "a"] } },
  { name: "пробелы строки", original: { text: " Текст " }, changed: { text: "Текст" } },
  {
    name: "переводы строк",
    original: { body: "Первая\nВторая" },
    changed: { body: "Первая Вторая" },
  },
  { name: "исходный адрес", original: { ref: "DOC-1" }, changed: { ref: "document-id" } },
  { name: "явное значение по умолчанию", original: {}, changed: { column: "inbox" } },
  {
    name: "пустой input",
    original: { op: "task.create" },
    changed: { op: "task.create", input: {} },
  },
] as const;
const invalidJsonValues = [
  { name: "undefined", value: { missing: undefined }, path: "$.missing" },
  {
    name: "пропуск массива",
    value: Object.assign(Array<string>(2), { 1: "пропуск" }),
    path: "$[0]",
  },
] as const;

describe("Граница формата атомарного пакета", () => {
  test.each(invalidRequests)("$name отклоняется с точным путём", ({ input, path }) => {
    let caught: unknown;
    try {
      parseBatch(prepareBatchInput(input, "author"), batchActions);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RelayError);
    if (!(caught instanceof RelayError)) {
      throw new Error("Ожидалась предметная ошибка");
    }
    expect(caught.code).toBe("INVALID_ARGUMENT");
    expect(caught.details?.path).toBe(path);
  });

  test("200 операций допустимы, нормализация не меняет исходный Markdown и объект", () => {
    const body = "  # Заголовок\n\n{$ref:task}\n";
    const input = {
      version: 1,
      operations: Array.from({ length: 200 }, () => ({
        op: "document.create",
        input: { name: "Документ", body },
      })),
    };
    const before = structuredClone(input);

    const operations = parseBatch(prepareBatchInput(input, "author"), batchActions);

    expect(operations).toHaveLength(200);
    expect(operations[0]?.input.body).toBe(body);
    expect(input).toEqual(before);
  });

  test("порядок свойств JSON не меняет нормализованный запрос", () => {
    const left = canonicalBatchJson({
      version: 1,
      operations: [{ input: { title: "Текст", description: "  Описание\n" }, op: "task.create" }],
    });
    const right = canonicalBatchJson({
      operations: [{ op: "task.create", input: { description: "  Описание\n", title: "Текст" } }],
      version: 1,
    });

    const expected =
      '{"operations":[{"input":{"description":"  Описание\\n","title":"Текст"},"op":"task.create"}],"version":1}';
    expect(JSON.stringify(left)).toBe(expected);
    expect(JSON.stringify(right)).toBe(expected);
  });

  test.each(significantJsonChanges)("$name меняет идентичность JSON", ({ original, changed }) => {
    const before = JSON.stringify(canonicalBatchJson(original));

    const after = JSON.stringify(canonicalBatchJson(changed));

    expect(after).not.toBe(before);
  });

  test.each(invalidJsonValues)(
    "$name не теряется при сериализации и сохраняет путь отказа",
    ({ value, path }) => {
      expect(() => canonicalBatchJson(value)).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2, details: { path } }),
      );
    },
  );

  test("циклический ввод отклоняется с путём обратной ссылки", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;

    expect(() => canonicalBatchJson(cycle)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        exitCode: 2,
        details: { path: "$.self" },
      }),
    );
  });
});
