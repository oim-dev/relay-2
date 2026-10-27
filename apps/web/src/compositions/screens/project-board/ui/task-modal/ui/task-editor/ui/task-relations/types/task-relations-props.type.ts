import type { BoardTask } from "domains/board-tasks";
/** Подзадачи текущей задачи и переходы к ним. */
export type TaskRelationsProps = {
  /** Проект, содержащий задачи. */
  projectId: string;
  /** Родительская задача. */
  task: BoardTask;
  /** Открывает выбранную подзадачу с сохранением контекста доски. */
  onOpen: (id: string, boardSlug?: string) => void;
};
