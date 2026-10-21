/**
 * Диагностики файловой границы Runtime.
 */
export const fileMessages = {
  /**
   * Сохраняет исходное пояснение ошибки локальной файловой операции.
   */
  localStorageFailure: (reason: string): string => `Ошибка локального хранилища: ${reason}`,
} as const;
