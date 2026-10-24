/**
 * Диагностики атомарной замены локального файла без привязки к формату содержимого.
 */
export const localFileMessages = {
  /**
   * Сохраняет имя native-операции и числовую причину безопасного отказа Windows rename.
   */
  windowsReplacementFailed: (syscall: string, code: number): string =>
    `Не удалось атомарно заменить локальный файл: ${syscall}, Win32 ${code}`,
} as const;
