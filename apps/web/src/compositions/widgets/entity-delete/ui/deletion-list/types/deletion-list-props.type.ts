import type { EntitySummary } from "domains/entities";

/** Группа последствий удаления в пределах диалога. */
export type DeletionListProps = {
  /** Название группы. */
  title: string;
  /** Полный набор затронутых записей. */
  entries: EntitySummary[];
  /** Верхняя граница высоты прокрутки в пикселях. */
  maxHeight: number;
};
