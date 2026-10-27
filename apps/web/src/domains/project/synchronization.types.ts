import type { GitSyncControlOutcome } from "@relay/contracts";

/**
 * Статус доставки и отдельно наблюдаемый исход последнего явного запроса.
 */
export interface ProjectSynchronization {
  /* Панель относится к механизму Git Sync, даже если подключение отсутствует. */
  isGit: boolean;
  /* Cached состояние доставки, не соединение SSE. */
  state: "local" | "synced" | "pending" | "syncing" | "offline" | "conflict" | "unknown";
  /* Неподтверждённые изменения; null означает неизвестное число. */
  queuedCommits: number | null;
  /* Неэкспортированные изменения; null не подменяется false. */
  hasUncommittedChanges: boolean | null;
  /* Подтверждённое время последнего обмена. */
  lastSuccessAt: string | null;
  /* Расписание не предоставляется текущим DTO. */
  nextAttemptAt: string | null;
  /* Маркер настроенного подключения, не URL удалённого репозитория. */
  origin: string | null;
  /* Ошибка Runtime. */
  error: string | null;
  /* Исход последнего now; null до первого запроса вкладки. */
  requestState: GitSyncControlOutcome["state"] | null;
  /* ID прежнего запроса; null, если потерян весь HTTP-ответ до получения ID. */
  requestId: string | null;
  /* Диагностика исхода запроса отдельно от cached статуса. */
  requestError: string | null;
}

/**
 * Удерживаемая идентичность операции до достоверного terminal outcome.
 */
export interface SynchronizationRequest {
  /* Исходный ID Server; null до ответа или после его полной потери. */
  requestId: string | null;
  /* Состояние запроса, не состояние доставки. */
  state: GitSyncControlOutcome["state"];
  /* Диагностика отказа или неопределённости. */
  error: string | null;
}
