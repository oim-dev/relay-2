import type { EntityRow } from "../entities/entity-queries.types";

/**
 * Исходный owner v3 и его обязательная переносимая версия до удаления inline-коллекций.
 */
export interface LegacyOwnerVersionRow extends EntityRow {
  /* Переносимый hash исходной строки; null означает потерянную запись версии. */
  readonly version: string | null;
  /* Исходный JSON непосредственных предков; null соответствует отсутствующей версии. */
  readonly parents_json: string | null;
}
