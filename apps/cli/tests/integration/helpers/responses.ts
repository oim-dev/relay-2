import assert from "node:assert/strict";
import { isEntityKind, type EntityRecord } from "@relay/contracts";
import type { ErrorResponse, PageResponse, SuccessResponse } from "./responses.types";

/**
 * Сужает внешнее значение до словаря полей JSON, исключая массивы и null.
 */
function isObjectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Проверяет объект на JSON-границе; неверная форма немедленно завершает тест.
 */
export function objectValue(value: unknown): Record<string, unknown> {
  assert(isObjectValue(value), "Ожидался JSON-объект");
  return value;
}

/**
 * Проверяет строку ответа, сохраняя пустое значение и значимые пробелы.
 */
export function stringValue(value: unknown): string {
  assert(typeof value === "string", "Ожидалась строка");
  return value;
}

/**
 * Проверяет массив ответа; декодирование элементов остаётся у вызывающего теста.
 */
export function arrayValue(value: unknown): unknown[] {
  assert(Array.isArray(value), "Ожидался массив");
  return value;
}

/**
 * Проверяет числовое поле ответа, отвергая NaN и бесконечности.
 */
function numberValue(value: unknown): number {
  assert(typeof value === "number" && Number.isFinite(value), "Ожидалось конечное число");
  return value;
}

/**
 * Декодирует запись на JSON-границе без предположений о предметной форме data.
 */
export function entityValue(value: unknown): EntityRecord {
  const record = objectValue(value);
  const kind = stringValue(record.kind);
  assert(isEntityKind(kind), `Неизвестный вид сущности: ${kind}`);
  return {
    id: stringValue(record.id),
    kind,
    key: stringValue(record.key),
    revision: numberValue(record.revision),
    data: objectValue(record.data),
    createdAt: stringValue(record.createdAt),
    updatedAt: stringValue(record.updatedAt),
    createdBy: stringValue(record.createdBy),
    updatedBy: stringValue(record.updatedBy),
  };
}

/**
 * Проверяет успешный конверт, обязательное data и форму необязательных метаданных.
 */
export function successValue(value: unknown): SuccessResponse {
  const response = objectValue(value);
  assert.equal(response.ok, true, "Ожидался успешный ответ CLI");
  assert(Object.hasOwn(response, "data"), "У ответа отсутствует data");
  return {
    data: response.data,
    ...(response.meta === undefined ? {} : { meta: objectValue(response.meta) }),
  };
}

/**
 * Проверяет конверт отказа и декодирует код, сообщение и необязательные детали.
 */
export function errorValue(value: unknown): ErrorResponse {
  const response = objectValue(value);
  assert.equal(response.ok, false, "Ожидался ответ с ошибкой CLI");
  const error = objectValue(response.error);
  return {
    code: stringValue(error.code),
    message: stringValue(error.message),
    ...(error.details === undefined ? {} : { details: objectValue(error.details) }),
  };
}

/**
 * Декодирует окно списка и подтверждает snapshot-контракт метаданных.
 * Декодер item проверяет каждый элемент; неверная форма не заменяется пустой страницей.
 */
export function pageValue<T>(
  response: SuccessResponse,
  item: (value: unknown) => T,
): PageResponse<T> {
  const data = objectValue(response.data);
  const page = objectValue(objectValue(response.meta).page);
  assert.equal(page.consistency, "snapshot");
  return {
    data: { ...data, items: arrayValue(data.items).map(item) },
    meta: {
      page: {
        count: numberValue(page.count),
        total: numberValue(page.total),
        limit: numberValue(page.limit),
        nextCursor: page.nextCursor === null ? null : stringValue(page.nextCursor),
        nextCommand: page.nextCommand === null ? null : stringValue(page.nextCommand),
        consistency: "snapshot",
      },
    },
  };
}
