import type { ComponentKind, PortableComponent } from "@relay/contracts";

/**
 * Полная SQL-строка первичной части, отдельная от предметной карточки.
 */
export interface ComponentRow {
  /* Постоянный ID владельца. */
  readonly owner_id: string;
  /* Закрытый вид части. */
  readonly kind: ComponentKind;
  /* Scoped постоянный ID. */
  readonly id: string;
  /* Естественное назначение, уникальное среди действующих частей вида. */
  readonly identity_key: string;
  /* Группа позиций, например ID этапа для task membership. */
  readonly group_id: string;
  /* Сохранённая плотная позиция. */
  readonly position: string;
  /* Переносимая версия; пустая только у адреса до завершения текущей транзакции. */
  readonly version: string;
  /* JSON непосредственных предков. */
  readonly parents_json: string;
  /* SQLite boolean tombstone. */
  readonly deleted: number;
  /* Точный JSON предметного значения. */
  readonly value: string;
  /* 1 лишь у SQL-created address до финализации версии в текущей транзакции. */
  readonly version_pending?: number;
}

/**
 * Режим выделения идентичностей при сохранении агрегата.
 */
export interface ComponentWriteOptions {
  /* true — детерминированные IDs технической миграции вместо новых UUID назначений. */
  readonly migration?: boolean;
  /* Предварительно выделенный ID transition/effect; exact commit обязан передать его для retry-стабильных IDs. */
  readonly allocationId?: string;
}

/**
 * Непереносимые поля индекса SQL для уже подготовленной части.
 */
export interface ComponentStorageEntry {
  /* Проверенная переносимая первичная запись. */
  readonly component: PortableComponent;
  /* Естественный ключ действующего назначения. */
  readonly identity: string;
  /* Область порядка внутри owner/kind. */
  readonly group: string;
}
