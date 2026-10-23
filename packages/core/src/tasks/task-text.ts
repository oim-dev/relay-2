import type { TaskTextOptions, TaskTextViolation } from "./task-text.types";
import { TASK_TITLE_TEXT_RULES } from "./task-constants";

/**
 * Проверяет заголовок задачи общим правилом ввода и хранения, сохраняя пустоту и пробелы.
 * Нестроковые значения, превышение длины, NUL и разделители строк считаются повреждением поля.
 */
export function isTaskTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    taskTextViolation(value, TASK_TITLE_TEXT_RULES.maximum, TASK_TITLE_TEXT_RULES) === undefined
  );
}

/**
 * Проверяет текст по общим правилам ввода и хранения без нормализации или создания ошибки.
 * Строковый тип проверяет вызывающая граница; длина измеряется в кодовых единицах UTF-16.
 * Возвращает первое нарушение в порядке формат → однострочность → обязательность;
 * undefined означает допустимый текст. Пустота разрешена, если required не задан.
 */
export function taskTextViolation(
  value: string,
  maximum: number,
  options: TaskTextOptions = {},
): TaskTextViolation | undefined {
  if (value.length > maximum || value.includes("\0")) {
    return "format";
  }
  if (options.singleLine && /[\r\n\u2028\u2029]/u.test(value)) {
    return "singleLine";
  }
  if (options.required && !value.trim()) {
    return "required";
  }
  return undefined;
}
