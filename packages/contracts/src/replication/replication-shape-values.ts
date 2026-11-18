import { RelayError } from "../errors/relay-error";
import { isPortableIdentityText, isPortableVersionParents } from "./portable-identity";
import { replicationShapeMessages } from "./replication-shape.messages";

/**
 * Отклоняет форму со стабильным кодом и путём; не обозначает нарушение предметного перехода.
 */
export function invalidReplicationShape(path: string): never {
  throw new RelayError("REPLICATION_FORMAT", replicationShapeMessages.invalid, 2, { path });
}

/**
 * Требует обычный JSON-объект; значения его полей остаются неизвестными до отдельных проверок.
 */
export function shapeObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return invalidReplicationShape(path);
  }
  // Проверена только объектная форма, без утверждения типов содержимого.
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Проверяет закрытый набор обязательных и optional-полей без подстановки отсутствующих значений.
 */
export function shapeFields(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      invalidReplicationShape(field);
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      invalidReplicationShape(field);
    }
  }
}

/**
 * Читает массив для проверки каждого элемента; пустота сама по себе не является ошибкой формы.
 */
export function shapeArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return invalidReplicationShape(path);
  }
  return value;
}

/**
 * Читает строку дословно, включая непарные UTF-16 units пользовательских текстов.
 */
export function shapeText(value: unknown, path: string): string {
  if (typeof value !== "string") {
    return invalidReplicationShape(path);
  }
  return value;
}

/**
 * Проверяет переносимость идентичности без нормализации, разрешения адреса или проверки существования.
 */
export function shapeIdentity(value: unknown, path: string): string {
  const text = shapeText(value, path);
  if (!isPortableIdentityText(text)) {
    invalidReplicationShape(path);
  }
  return text;
}

/**
 * Различает явный null и строку идентичности; undefined не является отсутствующей ссылкой.
 */
export function shapeNullableIdentity(value: unknown, path: string): void {
  if (value !== null) {
    shapeIdentity(value, path);
  }
}

/**
 * Проверяет синтаксис SHA-256, не вычисляя и не сопоставляя содержательный digest.
 */
export function shapeDigest(value: unknown, path: string): void {
  const text = shapeText(value, path);
  if (text.length !== 64 || !/^[a-f0-9]+$/.test(text)) {
    invalidReplicationShape(path);
  }
}

/**
 * Проверяет nullable digest; принадлежность версии конкретному владельцу проверяет Core.
 */
export function shapeNullableDigest(value: unknown, path: string): void {
  if (value !== null) {
    shapeDigest(value, path);
  }
}

/**
 * Проверяет форму целого счётчика в заданной нижней границе без обращения к состоянию реплики.
 */
export function shapeInteger(value: unknown, path: string, minimum = 0): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    invalidReplicationShape(path);
  }
}

/**
 * Проверяет канонический список родителей; причинная связь с исходной версией здесь не проверяется.
 */
export function shapeParents(value: unknown): void {
  if (!isPortableVersionParents(value)) {
    invalidReplicationShape("parents");
  }
}
