/**
 * Изолированное окружение одного библиотечного обмена; процессный host принадлежит CLI.
 */
export interface GitSyncExecutionOptions {
  /* Полный снимок среды Git/SSH; библиотека не изменяет process.env или cwd. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /* Отмена только этого обращения; пользовательские данные и outbox уже durable. */
  readonly signal?: AbortSignal;
  /* Общий бюджет I/O в ms; по умолчанию 120000, автоматический обмен ограничен 10000. */
  readonly timeoutMs?: number;
}
