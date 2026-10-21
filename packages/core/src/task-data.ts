import {
  RelayError,
  TASK_COLUMNS,
  type EntityRecord,
  type TaskColumn,
  type TaskComment,
  type TaskCriterion,
  type TaskRecord,
} from "@relay/contracts";
import type { TaskGraphNode } from "./task-graph";

type StoredTask = Pick<EntityRecord, "id" | "key" | "data">;

function corrupt(task: StoredTask): never {
  throw new RelayError("CORRUPT_DATA", `Повреждена задача ${task.key}`, 1, { id: task.id });
}

function object(value: unknown, task: StoredTask): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) corrupt(task);
  return value as Record<string, unknown>;
}

function text(value: unknown, task: StoredTask): string {
  if (typeof value !== "string") corrupt(task);
  return value;
}

function boolean(value: unknown, task: StoredTask): boolean {
  if (typeof value !== "boolean") corrupt(task);
  return value;
}

function column(value: unknown, task: StoredTask): TaskColumn {
  const result = TASK_COLUMNS.find((item) => item === value);
  if (result === undefined) corrupt(task);
  return result;
}

function array(value: unknown, task: StoredTask): unknown[] {
  if (!Array.isArray(value)) corrupt(task);
  return value;
}

function references(value: unknown, task: StoredTask): string[] {
  const result = array(value, task).map((item) => text(item, task));
  if (result.some((item) => !item) || new Set(result).size !== result.length) corrupt(task);
  return result;
}

function criteria(value: unknown, task: StoredTask): TaskCriterion[] {
  const result = array(value, task).map((entry): TaskCriterion => {
    const item = object(entry, task);
    const completed = boolean(item.completed, task);
    if (!completed && (item.completedAt !== null || item.completedBy !== null)) corrupt(task);
    return {
      id: text(item.id, task),
      title: text(item.title, task),
      summary: text(item.summary, task),
      description: text(item.description, task),
      completed,
      completedAt: completed ? text(item.completedAt, task) : null,
      completedBy: completed ? text(item.completedBy, task) : null,
    };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length) corrupt(task);
  return result;
}

function comments(value: unknown, task: StoredTask): TaskComment[] {
  return array(value, task).map((entry) => {
    const item = object(entry, task);
    return {
      id: text(item.id, task),
      title: text(item.title, task),
      body: text(item.body, task),
      createdAt: text(item.createdAt, task),
      createdBy: text(item.createdBy, task),
    };
  });
}

/** Декодирует только поля графовой проекции, не требуя содержания полной карточки. */
export function taskGraphNode(task: StoredTask): TaskGraphNode {
  const data = task.data;
  return {
    id: task.id,
    column: column(data.column, task),
    parentId: data.parentId === null ? null : text(data.parentId, task),
    dependencies: references(data.dependencies, task),
    acceptanceCriteria: array(data.acceptanceCriteria, task).map((entry) => ({
      completed: boolean(object(entry, task).completed, task),
    })),
  };
}

/** Полная карточка: отсутствие обязательного поля и null считаются повреждением. */
export function taskRecord(task: EntityRecord): TaskRecord {
  if (task.kind !== "task") corrupt(task);
  const data = task.data;
  return {
    ...task,
    kind: "task",
    data: {
      ...data,
      boardId: text(data.boardId, task),
      title: text(data.title, task),
      description: text(data.description, task),
      column: column(data.column, task),
      parentId: data.parentId === null ? null : text(data.parentId, task),
      dependencies: references(data.dependencies, task),
      related: references(data.related, task),
      targets: references(data.targets, task),
      acceptanceCriteria: criteria(data.acceptanceCriteria, task),
      comments: comments(data.comments, task),
    },
  };
}
