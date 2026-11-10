/**
 * Диагностики общей процессной оболочки Server → CLI → Git Sync.
 */
export const gitSyncRequestMessages = {
  invalid: "Недопустимый запрос Git Sync версии 1.",
  version: "Версия процессного протокола Git Sync не поддерживается.",
  argument: "Недопустимые параметры действия Git Sync.",
} as const;
