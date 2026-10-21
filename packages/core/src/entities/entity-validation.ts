import { RelayError, validateActor, type EntityRecord, type WriteOptions } from "@relay/contracts";
import { entityMessages } from "./entity.messages";
import type { EntityAddressField, EntityJsonObject, EntityJsonValue } from "./entity.types";

/**
 * Проверяет непустой адрес без краевых пробелов и управляющих символов.
 * Ключи и генерирующие их префиксы дополнительно запрещают пробелы и двоеточия.
 */
export function validateEntityAddress(
  value: unknown,
  field: EntityAddressField,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value) ||
    (field !== "ref" && /[\s:]/u.test(value))
  ) {
    throw new RelayError("VALIDATION_ERROR", entityMessages.invalidAddressField(field), 2, {
      field,
    });
  }
}

/**
 * Проверяет конечное JSON-дерево без изменения входа.
 * Набор предков принадлежит текущему обходу: повторное использование объекта допустимо,
 * обратная ссылка на предка и пропуски массива отклоняются как VALIDATION_ERROR.
 */
function validateJsonValue(value: unknown, parents: Set<object>): asserts value is EntityJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return;
  }
  if (typeof value !== "object" || parents.has(value)) {
    throw new RelayError("VALIDATION_ERROR", entityMessages.finiteJsonObject, 2);
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new RelayError("VALIDATION_ERROR", entityMessages.jsonValuesOnly, 2);
  }
  parents.add(value);
  // Итератор массива посещает и пропуски: undefined нельзя молча сохранить как null.
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    validateJsonValue(child, parents);
  }
  parents.delete(value);
}

/**
 * Проверяет корневой объект содержания до выделения ключа или начала записи.
 * Нестандартные прототипы, циклы и значения вне JSON отклоняются без изменения входа.
 */
export function validateEntityData(data: unknown): asserts data is EntityJsonObject {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new RelayError("VALIDATION_ERROR", entityMessages.expectedDataObject, 2);
  }
  validateJsonValue(data, new Set());
}

/**
 * Проверяет автора и исходную ревизию содержания перед любой записью, включая no-op.
 * Вызывается в общей транзакции чтения и изменения; несовпадение даёт REVISION_CONFLICT.
 */
export function validateEntityWrite(
  entity: Readonly<EntityRecord>,
  options: Readonly<WriteOptions>,
): void {
  validateActor(options.actor);
  if (!Number.isSafeInteger(options.ifRevision) || options.ifRevision < 1) {
    throw new RelayError("VALIDATION_ERROR", entityMessages.positiveRevision, 2);
  }
  if (entity.revision !== options.ifRevision) {
    throw new RelayError("REVISION_CONFLICT", entityMessages.revisionConflict, 4, {
      id: entity.id,
      expectedRevision: options.ifRevision,
      actualRevision: entity.revision,
    });
  }
}
