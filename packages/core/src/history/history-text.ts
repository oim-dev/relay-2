import type { HistoryTextOptions } from "./history-input.types";

/**
 * Правила заголовков сессии и материала истории: запрещены CR/LF, но не U+2028/U+2029.
 */
export const HISTORY_TITLE_RULES = { singleLine: true } as const;

/**
 * Проверяет непустоту и формат текста истории без нормализации и зависимости от БД.
 * Строковый тип проверяет вызывающая граница. Ограничения длины и запрета NUL у истории нет.
 * undefined означает допустимый текст; код ошибки выбирает граница ввода либо хранения.
 */
export function historyTextViolation(
  value: string,
  options: HistoryTextOptions = {},
): "required" | "singleLine" | undefined {
  if (!value.trim()) {
    return "required";
  }
  if (options.singleLine && /[\r\n]/u.test(value)) {
    return "singleLine";
  }
  return undefined;
}
