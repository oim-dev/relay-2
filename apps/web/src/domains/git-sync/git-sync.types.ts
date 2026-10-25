import type { GitSyncControlOutcome } from "@relay/contracts";

/**
 * Явное ручное окно синхронизации и наблюдение первоначального исхода.
 */
export interface GitSyncRequestState {
  /* Запускает одно now через Server/Runtime, без автоматического повторения. */
  readonly request: () => Promise<void>;
  /* Повторно читает сохранённый requestId, не создавая нового окна обмена. */
  readonly refresh: () => Promise<void>;
  /* HTTP ещё выполняется либо Runtime подтвердил очередь/исполнение. */
  readonly pending: boolean;
  /* Проверенный Runtime исход; undefined до принятия запроса. */
  readonly outcome: GitSyncControlOutcome | undefined;
  /* Диагностика при отсутствии корректного ответа. */
  readonly error: string | undefined;
}
