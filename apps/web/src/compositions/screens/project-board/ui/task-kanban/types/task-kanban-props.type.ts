import type { TaskColumn, TaskFilters } from "domains/board-tasks";

/** Канбан одной доски с общими фильтрами. */
export type TaskKanbanProps = {
  projectId: string;
  filters: TaskFilters;
  showCancelled: boolean;
  onOpen: (id: string) => void;
  onCreate: (column: TaskColumn) => void;
};
