import type { EntityIdentity, EntityKind, EntityRecord } from "@relay/contracts";

/**
 * Совпадение обычного адреса из entity_refs без содержания сущности.
 */
export interface EntityReferenceIdentity extends EntityIdentity {
  /* Исходный ID, ключ или алиас, совпавший с записью entity_refs. */
  readonly ref: string;
}

/**
 * Идентичность и ревизия содержания для сравнения адресно выбранных составов без полных карточек.
 * Все значения принадлежат столбцам entities; содержание JSON и журнал комментариев не выбираются.
 */
export interface EntityIdentityWithRevision extends Readonly<EntityIdentity> {
  /* Положительная ревизия содержания; независимые комментарии задачи её не меняют. */
  readonly revision: number;
}

/**
 * Узкая сырая проекция краткой карточки; предметную форму значений проверяет Core.
 * undefined означает отсутствующее JSON-поле, null сохраняет явный JSON null.
 */
export interface EntitySummaryProjection extends Readonly<EntityIdentity> {
  /* Положительная ревизия содержания, ограниченная схемой SQLite. */
  readonly revision: number;
  /* Только сохранённое name/title; отсутствие имени у seed-продукта допустимо. */
  readonly title: unknown;
  /* Только column/documentStatus/status применимого вида; иначе undefined. */
  readonly state: unknown;
  /* Только active реализации; иначе undefined. */
  readonly active: unknown;
}

/**
 * SQL-строка краткой проекции: JSON сохраняет тип каждого отдельного поля.
 */
export interface EntitySummaryRow extends Readonly<EntityIdentity> {
  /* Ревизия содержания из entities. */
  readonly revision: number;
  /* JSON выбранного name/title; SQL null означает отсутствие поля. */
  readonly title: string | null;
  /* JSON сохранённого состояния применимого вида; SQL null означает отсутствие поля. */
  readonly state: string | null;
  /* JSON активности реализации, позволяющий отличить boolean от числа; иначе SQL null. */
  readonly active: string | null;
}

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
