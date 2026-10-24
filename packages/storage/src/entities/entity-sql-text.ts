import { RelayError, isPortableIdentityText, type EntityRecord } from "@relay/contracts";
import { entityMessages } from "./entity.messages";

/**
 * Не допускает тихую UTF-16→UTF-8 подмену plain SQL TEXT идентичности или метаданных.
 * JSON body/name сюда не передаются: JSON escape сохраняет их непарные code units.
 */
export function assertSqlText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !isPortableIdentityText(value)) {
    throw new RelayError("INVALID_ARGUMENT", entityMessages.invalidSqlText, 2, { field });
  }
}

/**
 * Проверяет все plainTEXT поля owner до binding; содержимое data остаётся JSON-carrier.
 */
export function assertEntitySqlText(record: Readonly<EntityRecord>): void {
  for (const field of [
    "id",
    "kind",
    "key",
    "createdAt",
    "updatedAt",
    "createdBy",
    "updatedBy",
  ] as const) {
    assertSqlText(record[field], field);
  }
}

/**
 * Проверяет пакет адресов/IDs перед единственным SQL-чтением, не меняя значения.
 */
export function assertSqlReferences(refs: readonly string[]): void {
  for (const ref of refs) {
    assertSqlText(ref, "ref");
  }
}
