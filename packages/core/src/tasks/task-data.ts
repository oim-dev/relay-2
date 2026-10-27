/**
 * Граница хранения задач: полная карточка и узкая проекция обязательств имеют разные декодеры.
 * Отсутствующие обязательные поля и неверные значения отвергаются, а не заменяются значениями по умолчанию.
 */
import {
  RelayError,
  TASK_COLUMNS,
  type EntityRecord,
  type TaskColumn,
  type TaskComment,
  type TaskCriterion,
  type TaskRecord,
} from "@relay/contracts";
import { TASK_CRITERION_TEXT_RULES } from "./task-constants";
import type { StoredTask, TaskViewRecord } from "./task-data.types";
import type { TaskGraphNode } from "./task-graph.types";
import type { TaskCriterionContent } from "./task-input.types";
import { taskMessages } from "./task-messages";
import { isTaskTitle, taskTextViolation } from "./task-text";

/**
 * Сообщает о повреждении сохранённой задачи, включая постоянный ID в детали ошибки.
 */
function corrupt(task: StoredTask): never {
  throw new RelayError("CORRUPT_DATA", taskMessages.corruptTask(task.key), 1, { id: task.id });
}

/**
 * Сужает сохранённое значение до объекта, не утверждая тип его вложенных полей.
 */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Декодирует объект сохранённых полей; null и массив считаются повреждением.
 */
function object(value: unknown, task: StoredTask): Readonly<Record<string, unknown>> {
  if (!isObject(value)) {
    corrupt(task);
  }
  return value;
}

/**
 * Декодирует обязательную строку без нормализации сохранённого содержания.
 */
function text(value: unknown, task: StoredTask): string {
  if (typeof value !== "string") {
    corrupt(task);
  }
  return value;
}

/**
 * Декодирует отметку выполнения без приведения truthy/falsy значений.
 */
function boolean(value: unknown, task: StoredTask): boolean {
  if (typeof value !== "boolean") {
    corrupt(task);
  }
  return value;
}

/**
 * Декодирует сохранённую колонку по общему перечислению контракта задач.
 */
function column(value: unknown, task: StoredTask): TaskColumn {
  const result = TASK_COLUMNS.find((item) => item === value);
  if (result === undefined) {
    corrupt(task);
  }
  return result;
}

/**
 * Декодирует обязательный массив, сохраняя пропуски для последующей проверки элементов.
 */
function array(value: unknown, task: StoredTask): unknown[] {
  if (!Array.isArray(value)) {
    corrupt(task);
  }
  return Array.from(value);
}

/**
 * Декодирует непустые уникальные постоянные ID в сохранённом порядке.
 */
function references(value: unknown, task: StoredTask): string[] {
  const result = array(value, task).map((item) => text(item, task));
  if (result.some((item) => !item) || new Set(result).size !== result.length) {
    corrupt(task);
  }
  return result;
}

/**
 * Проверяет сохранённый текст критерия по общему правилу ввода, но отказывает как CORRUPT_DATA.
 * Значения по умолчанию не подставляются; пустые summary и description остаются допустимыми.
 */
function criterionText(
  value: unknown,
  field: keyof TaskCriterionContent,
  task: StoredTask,
): string {
  const result = text(value, task);
  const rule = TASK_CRITERION_TEXT_RULES[field];
  if (taskTextViolation(result, rule.maximum, rule) !== undefined) {
    corrupt(task);
  }
  return result;
}

/**
 * Декодирует критерий с проверенными текстами и согласованной отметкой выполнения.
 * У невыполненного автора и времени быть не может; заголовок обязателен, пояснения могут быть пусты.
 */
function criterion(value: unknown, task: StoredTask): TaskCriterion {
  const item = object(value, task);
  const completed = boolean(item.completed, task);
  if (!completed && (item.completedAt !== null || item.completedBy !== null)) {
    corrupt(task);
  }
  return {
    id: text(item.id, task),
    title: criterionText(item.title, "title", task),
    summary: criterionText(item.summary, "summary", task),
    description: criterionText(item.description, "description", task),
    completed,
    completedAt: completed ? text(item.completedAt, task) : null,
    completedBy: completed ? text(item.completedBy, task) : null,
  };
}

/**
 * Декодирует критерии, отвергая повтор одного ID внутри задачи.
 */
function criteria(value: unknown, task: StoredTask): TaskCriterion[] {
  const result = array(value, task).map((entry) => criterion(entry, task));
  if (new Set(result.map((item) => item.id)).size !== result.length) {
    corrupt(task);
  }
  return result;
}

/**
 * Декодирует проекцию независимого журнала комментариев без изменения его порядка.
 */
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

/**
 * Декодирует только поля графовой проекции, не требуя доску, тексты или журнал полной карточки.
 */
export function taskGraphNode(task: StoredTask): TaskGraphNode {
  const data = object(task.data, task);
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

/**
 * Декодирует metadata задачи и присоединяет проверенные отметки её графа того же snapshot.
 * Отсутствие описания/журнала означает выбранную узкую проекцию, а не пустое содержание.
 */
export function taskViewRecord(task: EntityRecord, graph: TaskGraphNode): TaskViewRecord {
  if (task.kind !== "task" || task.id !== graph.id) {
    corrupt(task);
  }
  const data = object(task.data, task);
  if (!isTaskTitle(data.title)) {
    corrupt(task);
  }
  return {
    ...task,
    kind: "task",
    data: {
      boardId: text(data.boardId, task),
      title: data.title,
      column: column(data.column, task),
      parentId: data.parentId === null ? null : text(data.parentId, task),
      dependencies: references(data.dependencies, task),
      related: references(data.related, task),
      targets: references(data.targets, task),
      acceptanceCriteria: graph.acceptanceCriteria,
    },
  };
}

/**
 * Декодирует полную карточку: отсутствие обязательного поля и недопустимый null означают CORRUPT_DATA.
 * Дополнительные сохранённые поля сохраняются; журнал уже должен быть присоединён Storage.
 */
export function taskRecord(task: Readonly<EntityRecord | TaskRecord>): TaskRecord {
  if (task.kind !== "task") {
    corrupt(task);
  }
  const data = object(task.data, task);
  if (!isTaskTitle(data.title)) {
    corrupt(task);
  }
  return {
    ...task,
    kind: "task",
    data: {
      ...data,
      boardId: text(data.boardId, task),
      title: data.title,
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
