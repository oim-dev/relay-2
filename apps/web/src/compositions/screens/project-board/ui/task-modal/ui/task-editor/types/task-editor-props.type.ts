import type { BoardTask } from "domains/board-tasks";
/** Содержание задачи и действия редактора. */
export type TaskEditorProps = {
  projectId: string;
  task: BoardTask;
  startEditing: boolean;
  onOpen: (id: string, boardSlug?: string) => void;
  onClose: () => void;
};
