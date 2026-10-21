/**
 * Тексты внешней границы ошибок CLI и процессных потоков.
 */
export const errorMessages = {
  unknown: "Неизвестная ошибка",
  help: "Справка: relay --help\n",

  /**
   * Оформляет стабильный код и уже очищенное сообщение в текстовую диагностику.
   */
  failure: (code: string, message: string): string => `Ошибка: ${code}: ${message}\n`,
} as const;
