/**
 * Ошибки доверенного локального process helper, без аргументов и окружения запуска.
 */
export const processMessages = {
  guardianRequired:
    "Compiled-приложение должно передать guardianComponent с собственной private ролью --guarded-command.",
  guardianFailed: "Доверенный helper завершился без подтверждённого результата команды.",
  cleanupFailed:
    "Не удалось подтвердить завершение контейнера дочерних процессов за отведённое время.",
} as const;
