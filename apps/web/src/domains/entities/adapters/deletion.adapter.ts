import type { EntityDeletionQuery, EntityDeletionPreview } from "../types/entity-deletion.type";

const unavailable =
  "Текущий Relay Server не предоставляет удаление сущностей и предпросмотр каскада. Никакие данные не изменены.";

/**
 * Явный отказ неподдерживаемой операции, не успешная имитация удаления.
 */
export class EntityDeletionError extends Error {
  readonly shouldRefresh = false;
}

/**
 * Не обещает старый каскад, отсутствующий в актуальном Core/API.
 */
export async function previewEntityDeletion(
  _project: string,
  _query: EntityDeletionQuery,
): Promise<EntityDeletionPreview> {
  throw new EntityDeletionError(unavailable);
}

/**
 * Защищает также прямого потребителя от фиктивного успешного удаления.
 */
export async function deleteEntity(
  _project: string,
  _command: EntityDeletionQuery & { ifVersion: string; requestId: string },
): Promise<never> {
  throw new EntityDeletionError(unavailable);
}
