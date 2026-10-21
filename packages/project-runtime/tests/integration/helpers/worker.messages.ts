/**
 * Диагностики протокола вспомогательных процессов интеграционных тестов.
 */
export const workerMessages = {
  missingInput: "Не переданы параметры процесса проверки",
  invalidInitializationInput: "Некорректные параметры процесса инициализации",
  invalidRegistrationInput: "Некорректные параметры процесса регистрации",
  invalidInitializationResult: "Некорректный ответ процесса инициализации",
  homeNotIsolated: "Процесс проверки не изолировал домашний каталог",
  publicationNotReleased: "Координатор не разрешил публикацию подготовленного проекта",
  incompleteWorkspace: "Читатель получил неполную конфигурацию workspace",

  /**
   * Показывает завершение worker, не дошедшего до барьера готовности.
   */
  exitedBeforeReady: (exit: number, stderr: string): string =>
    `Процесс завершился до готовности: ${exit}; ${stderr}`,
} as const;
