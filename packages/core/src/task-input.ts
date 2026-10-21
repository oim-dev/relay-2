import { randomUUID } from "node:crypto";
import { RelayError, TASK_COLUMNS, type TaskColumn, type TaskCriterion } from "@relay/contracts";

/** Проверки внешнего ввода задач; сохранённые данные декодирует task-data. */
export function invalid(message: string): never {
  throw new RelayError("INVALID_ARGUMENT", message, 2);
}

export function object(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label}: ожидается объект`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid(`${label}: ожидается обычный объект полей`);
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!fields.includes(key)) invalid(`${label}: неизвестное поле ${key}`);
    if (result[key] === undefined) invalid(`${label}: поле ${key} не может быть undefined`);
    if (result[key] === null && key !== "parent")
      invalid(`${label}: поле ${key} не может быть null`);
  }
  return result;
}

export function text(
  value: unknown,
  name: string,
  max: number,
  singleLine = false,
  required = false,
): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    invalid(`${name}: ожидается строка длиной не более ${max} символов без NUL`);
  }
  if (singleLine && /[\r\n\u2028\u2029]/u.test(value)) invalid(`${name}: нужна одна строка`);
  if (required && !value.trim()) invalid(`${name}: пустое значение недопустимо`);
  return value;
}

export function reference(value: unknown, name: string): string {
  const result = text(value, name, 256, true, true);
  if (result !== result.trim() || /\p{Cc}/u.test(result))
    invalid(`${name}: пробелы по краям и управляющие символы недопустимы`);
  return result;
}

export function column(value: unknown): TaskColumn {
  const result = TASK_COLUMNS.find((item) => item === value);
  if (result === undefined) {
    invalid(`Неизвестная колонка; допустимы ${TASK_COLUMNS.join(", ")}`);
  }
  return result;
}

export function choice<T extends string>(value: unknown, variants: readonly T[], name: string): T {
  const result = variants.find((item) => item === value);
  if (result === undefined) {
    invalid(`${name}: допустимы ${variants.join(", ")}`);
  }
  return result;
}

export function array(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    invalid(`${name}: ожидается массив длиной не более ${max}`);
  }
  return value;
}

export function criterionContent(
  input: unknown,
): Pick<TaskCriterion, "title" | "summary" | "description"> {
  const value = object(input, ["title", "summary", "description"], "Критерий");
  return {
    title: text(value.title, "Заголовок критерия", 1024, true, true),
    summary: text(value.summary ?? "", "Краткое описание критерия", 4096),
    description: text(value.description ?? "", "Описание критерия", 256 * 1024),
  };
}

export function newCriterion(input: unknown): TaskCriterion {
  return {
    id: randomUUID(),
    ...criterionContent(input),
    completed: false,
    completedAt: null,
    completedBy: null,
  };
}
