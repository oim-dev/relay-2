import type { TaskTextOptions, TaskTextViolation } from "./task-text.types";

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
