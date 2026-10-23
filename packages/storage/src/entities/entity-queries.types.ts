import type { EntityKind, EntityRecord } from "@relay/contracts";

/**
 * Минимальная проекция существующей сущности для проверки CAS по постоянному ID.
 */
export type EntityRevision = Pick<EntityRecord, "id" | "revision">;

/**
 * Строка SQL-проекции сущности до декодирования JSON; предметную форму data проверяет Core.
 */
export interface EntityRow {
  /* Постоянный ID сущности в проекте. */
  readonly id: string;
  /* Вид сущности, ограниченный CHECK схемы. */
  readonly kind: EntityKind;
  /* Текущий читаемый ключ, уникальный в общем пространстве ссылок. */
  readonly key: string;
  /* Положительная ревизия содержания; журнал комментариев имеет независимый порядок. */
  readonly revision: number;
  /* Неизменяемая отметка создания, записанная Core в строковом формате. */
  readonly created_at: string;
  /* Отметка последнего изменения содержания. */
  readonly updated_at: string;
  /* Неизменяемый автор создания сущности. */
  readonly created_by: string;
  /* Автор последнего изменения содержания. */
  readonly updated_by: string;
  /* JSON-объект содержания без независимого журнала комментариев. */
  readonly data: string;
  /* JSON-массив комментариев по sequence; null означает отсутствие проекции в запросе. */
  readonly comments: string | null;
}

/**
 * Полный счётчик сущностей для выбранного SQL-фильтра.
 */
export interface EntityCountRow {
  /* Число записей до ограничения страницы, включая ноль для пустого набора. */
  readonly count: number;
}

/**
 * Результат атомарного продвижения счётчика читаемых ключей.
 */
export interface KeyCounterRow {
  /* Зарезервированный положительный номер внутри одного префикса. */
  readonly value: number;
}
