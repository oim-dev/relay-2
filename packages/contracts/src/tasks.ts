import type { EntityRecord } from "./index";

export const TASK_COLUMNS = [
  "inbox",
  "ready",
  "in-progress",
  "review",
  "done",
  "cancelled",
] as const;

export type TaskColumn = (typeof TASK_COLUMNS)[number];

export type TaskCriterion = {
  id: string;
  title: string;
  summary: string;
  description: string;
  completed: boolean;
  completedAt: string | null;
  completedBy: string | null;
};

export type TaskComment = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  createdBy: string;
};

export type TaskData = {
  boardId: string;
  title: string;
  description: string;
  column: TaskColumn;
  parentId: string | null;
  dependencies: string[];
  related: string[];
  targets: string[];
  acceptanceCriteria: TaskCriterion[];
  /** Проекция отдельного append-only журнала, не часть ревизии содержания задачи. */
  comments: TaskComment[];
};

export type TaskRecord = Omit<EntityRecord, "kind" | "data"> & {
  kind: "task";
  data: TaskData;
};

export interface TaskProgress {
  completed: boolean;
  canComplete: boolean;
  /** Постоянные ID невыполненных прямых детей и зависимостей, без повторов. */
  blockers: string[];
}
