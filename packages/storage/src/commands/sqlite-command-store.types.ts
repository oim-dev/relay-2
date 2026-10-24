import type { SynchronousOperation } from "../sqlite/transaction.types";

/**
 * Владелец соединения команд: обе границы завершают строго синхронный callback до возврата.
 * Внешняя transaction атомарно публикует SQL-очереди репликации; snapshot ничего не публикует.
 */
export interface SqliteCommandStoreHost {
  /* Постоянный ID проекта уже проверенного соединения. */
  readonly projectId: string;
  /**
   * Удерживает один согласованный снимок всех выборок, не открывая асинхронную область.
   */
  snapshot<T>(operation: SynchronousOperation<T>): T;
  /**
   * Удерживает BEGIN IMMEDIATE, откатывает исключение и выполняет outer outbox flush перед commit.
   */
  transaction<T>(operation: SynchronousOperation<T>): T;
}
