import type { TaskColumn } from "@relay/contracts";

/**
 * Колонка одной доски с собственным продолжаемым серверным окном.
 */
export interface BoardColumnProps {
  /* Постоянный ID доски. */
  readonly boardId: string;
  /* Одна текущая колонка Core. */
  readonly column: TaskColumn;
  /* Серверные фильтры поиска и готовности. */
  readonly filters: Record<string, string>;
}
