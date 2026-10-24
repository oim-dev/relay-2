import type { EntityRecord, ReplicationChangeset } from "@relay/contracts";
import type { ProjectLocation } from "@relay/project-runtime";

/**
 * Изолированные пути одной незавершённой публикации, созданной настоящим restore worker.
 */
export interface PendingRestorationFixture {
  /* Выбранные ID/публичная БД/config до resume. */
  readonly location: ProjectLocation;
  /* Собственный staging с publication.json и SQLite. */
  readonly stagingPath: string;
  /* Публичный hardlink intent. */
  readonly publicationPath: string;
}

/**
 * Наблюдаемые данные реплики для проверки отсутствия bootstrap, echo и потери поздней записи.
 */
export interface PreservedRestorationData {
  /* Корневая карточка с точными автором, содержимым и локальной ревизией. */
  readonly project: EntityRecord;
  /* Постоянный ID локальной реплики, который resume не перевыдаёт. */
  readonly replicaId: string;
  /* Исходные неподтверждённые changesets, включая поздний принятый commit. */
  readonly outbox: readonly ReplicationChangeset[];
}
