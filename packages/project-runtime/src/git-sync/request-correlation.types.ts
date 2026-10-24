import type { GitSyncRequest } from "@relay/contracts";

/**
 * Идентичность явной операции; режим отличает новый submit от read-only ожидания/запроса исхода.
 */
export interface GitSyncRequestCorrelation {
  /* ID операции, назначенный до запуска компонента либо полученный от вызывающего. */
  readonly requestId: string;
  /* submit добавляет operationId; wait/read никогда не создают новую операцию. */
  readonly mode: "submit" | "wait" | "read";
}

/**
 * Подготовленный envelope v1 без изменения пользовательского объекта.
 */
export interface CorrelatedGitSyncRequest {
  /* Исходный запрос с единственным дополнительным input.operationId для нового now/refresh. */
  readonly request: GitSyncRequest;
  /* Отсутствует у действий, не создающих/не запрашивающих network outcome. */
  readonly correlation?: GitSyncRequestCorrelation;
}
