import type { EntitySummary } from "./entity-summary.type";

/**
 * Адрес недоступного в текущем API сценария удаления.
 */
export interface EntityDeletionQuery {
  /* Постоянный адрес сущности. */
  ref: string;
  /* Вид выбранного экрана. */
  kind: string;
}

/**
 * Представление сохранённого диалога; текущий API не выдаёт такой предпросмотр.
 */
export interface EntityDeletionPreview {
  /* Карточка цели. */
  target: EntitySummary;
  /* Удаляемые записи. */
  deleted: EntitySummary[];
  /* Сохраняемые записи. */
  detached: EntitySummary[];
  /* Число снятых отношений. */
  relations: number;
  /* Исходная версия предпросмотра. */
  version: string;
}
