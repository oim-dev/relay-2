import assert from "node:assert/strict";
import type { EntityKind, EntityRecord } from "@relay/contracts";
import type { Page } from "../../../src/pagination";

export interface SuccessResponse {
  data: unknown;
  meta?: Record<string, unknown>;
}

export interface PageResponse<T> {
  data: Record<string, unknown> & { items: T[] };
  meta: { page: Page };
}

export interface ErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function objectValue(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Ожидался JSON-объект",
  );
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown): string {
  assert.equal(typeof value, "string", "Ожидалась строка");
  return value as string;
}

export function arrayValue(value: unknown): unknown[] {
  assert(Array.isArray(value), "Ожидался массив");
  return value;
}

function numberValue(value: unknown): number {
  assert(typeof value === "number" && Number.isFinite(value), "Ожидалось конечное число");
  return value;
}

const kinds: readonly EntityKind[] = [
  "project",
  "product",
  "feature",
  "scenario",
  "application",
  "implementation",
  "board",
  "task",
  "document",
  "work-plan",
  "release",
  "work-session",
  "work-checkpoint",
];

/** Тип результата подтверждаем на JSON-границе, а не произвольным success<T>(). */
export function entityValue(value: unknown): EntityRecord {
  const record = objectValue(value);
  const kind = stringValue(record.kind);
  assert(
    kinds.some((candidate) => candidate === kind),
    `Неизвестный вид сущности: ${kind}`,
  );
  return {
    id: stringValue(record.id),
    kind: kind as EntityKind,
    key: stringValue(record.key),
    revision: numberValue(record.revision),
    data: objectValue(record.data),
    createdAt: stringValue(record.createdAt),
    updatedAt: stringValue(record.updatedAt),
    createdBy: stringValue(record.createdBy),
    updatedBy: stringValue(record.updatedBy),
  };
}

export function successValue(value: unknown): SuccessResponse {
  const response = objectValue(value);
  assert.equal(response.ok, true, "Ожидался успешный ответ CLI");
  assert(Object.hasOwn(response, "data"), "У ответа отсутствует data");
  return {
    data: response.data,
    ...(response.meta === undefined ? {} : { meta: objectValue(response.meta) }),
  };
}

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
