import { ENTITY_KINDS, isPortableVersionParents, type EntityKind } from "@relay/contracts";
import { identityText, invalidRow, rowObject } from "./columns";
import type { SqlRow, SqlScalar } from "./columns.types";

/**
 * Требует закрытый набор обязательных полей и отдельно перечисленных optional-полей.
 */
export function exactFields(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      invalidRow(field);
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      invalidRow(field);
    }
  }
}

/**
 * Проверяет скалярные SQL-слоты внешнего JSON, не принимая вложенные контейнеры.
 */
export function portableSqlRow(value: unknown): SqlRow {
  const object = rowObject(value, "row");
  const entries: [string, SqlScalar][] = [];
  for (const [field, entry] of Object.entries(object)) {
    if (entry === null || (typeof entry === "number" && Number.isSafeInteger(entry))) {
      entries.push([field, entry]);
    } else {
      entries.push([field, identityText(entry, field)]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Разбирает технический JSON с единой ошибкой физической формы вместо SyntaxError.
 */
export function portableJson(value: unknown, field: string): unknown {
  const text = identityText(value, field);
  try {
    return JSON.parse(text);
  } catch {
    return invalidRow(field);
  }
}

/**
 * Возвращает массив неизвестных значений для последующей проверки каждого элемента.
 */
export function portableArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return invalidRow(field);
  }
  return value;
}

/**
 * Проверяет непустую переносимую идентичность; пользовательский текст проверяется отдельно.
 */
export function portableId(value: unknown, field: string): string {
  const text = identityText(value, field);
  if (text.length === 0) {
    invalidRow(field);
  }
  return text;
}

/**
 * Читает известный вид предметной идентичности без утверждения типа по строке.
 */
export function portableKind(value: unknown): EntityKind {
  const kind = ENTITY_KINDS.find((candidate) => candidate === value);
  return kind ?? invalidRow("kind");
}

/**
 * Проверяет целое число в явной нижней границе физического контракта.
 */
export function portableInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return invalidRow(field);
  }
  return value;
}

/**
 * Читает SHA-256 переносимой версии, не вычисляя предметный digest.
 */
export function portableVersion(value: unknown, field: string): string {
  const text = identityText(value, field);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    invalidRow(field);
  }
  return text;
}

/**
 * Проверяет канонический массив родителей, сохраняя исходный порядок и значения.
 */
export function portableParents(value: unknown): readonly string[] {
  if (!isPortableVersionParents(value)) {
    return invalidRow("parents");
  }
  return value;
}

/**
 * Сравнивает переносимые идентичности по code units, независимо от locale хоста.
 */
export function comparePortableText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
