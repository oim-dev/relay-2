/**
 * Диагностики файловой границы Runtime.
 */
export const fileMessages = {
  /**
   * Сохраняет исходное пояснение ошибки локальной файловой операции.
   */
  localStorageFailure: (reason: string): string => `Ошибка локального хранилища: ${reason}`,
  /**
   * Описывает цикл файловых символьных ссылок без изменения исходного пути.
   */
  symbolicLinkCycle: (path: string): string => `Циклическая символьная ссылка: ${path}`,
} as const;
