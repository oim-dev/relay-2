import type { EntityDeletionQuery } from "domains/entities";

/** Параметры удаления сохранённой сущности. */
export type EntityDeleteProps = {
  /** Постоянный ID записи, не изменяемый ключ. */
  entityId: string;
  /** Предметный сценарий удаления. */
  kind: EntityDeletionQuery["kind"];
  /** Переход после получения квитанции, до обновления каталогов. */
  onDeleted: () => void;
  /** Приостанавливает управление родительским окном на время подтверждения. */
  onOpenedChange?: (isOpened: boolean) => void;
};
