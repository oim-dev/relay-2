import type { EntityRecord } from "@relay/contracts";

/**
 * Независимое нарушение неизменяемых полей или последовательности ревизии сущности.
 */
export interface ImmutableEntityCase {
  /* Причина отказа, видимая в имени отдельного теста. */
  readonly name: string;
  /* Намеренно неверные поля, накладываемые на допустимое обновление ревизии 1 → 2. */
  readonly patch: Readonly<Partial<EntityRecord>>;
}

/**
 * Независимый обход публичного API для проверки ограничений журнала непосредственно в SQLite.
 */
export interface CommentConstraintCase {
  /* Защищаемое ограничение SQL, видимое в названии теста. */
  readonly name: string;
  /* SQL с одним параметром: ID строки или владельца, выбранный target. */
  readonly sql: string;
  /* Подготовленная цель намеренно запрещённой записи. */
  readonly target: "comment" | "task" | "product" | "missing";
  /* Независимый фрагмент ошибки SQLite, исключающий постороннюю причину отказа. */
  readonly expectedMessage: string;
}
