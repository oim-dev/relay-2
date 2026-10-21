import type { EntityKind } from "@relay/contracts";

/**
 * Назначение строкового адреса при проверке ссылок и назначении ключа.
 */
export type EntityAddressField = "ref" | "prefix" | "key";

/**
 * Разобранная пользовательская ссылка до обращения к хранилищу.
 */
export interface EntityReference {
  /* ID, ключ, алиас или виртуальный адрес без префикса вида. */
  readonly ref: string;
  /* Ожидаемый вид записи; undefined разрешает прямой адрес любого вида. */
  readonly kind: EntityKind | undefined;
}

/**
 * Проверенное JSON-значение без циклов и пропусков массивов, только с конечными числами.
 */
export type EntityJsonValue =
  null | string | boolean | number | readonly EntityJsonValue[] | EntityJsonObject;

/**
 * Проверенный JSON-объект для внутренней записи предметного содержания.
 * Допускается обычный объект или объект без прототипа; вход не изменяется.
 */
export interface EntityJsonObject {
  /* Собственные перечислимые поля содержания, проверенные перед сохранением. */
  readonly [field: string]: EntityJsonValue;
}
