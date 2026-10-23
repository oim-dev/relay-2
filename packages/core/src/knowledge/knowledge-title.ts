/**
 * Проверяет сохранённое название знания без нормализации: оно непустое и однострочное.
 * CR/LF и U+2028/U+2029 запрещены; общего лимита длины и запрета остальных управляющих символов нет.
 * Каноническое имя проекта дополнительно проверяется общим isProjectName из Contracts.
 */
export function isKnowledgeTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n\u2028\u2029]/u.test(value);
}
