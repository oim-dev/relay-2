import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { localLockMessages } from "./local-lock.messages";
import { errorCode } from "../sqlite/sqlite-errors";
import { isAsyncFunction, isPromiseLike } from "../sqlite/transaction-callback";
import type { SynchronousOperation } from "../sqlite/transaction.types";
import { SQLITE_BUSY_TIMEOUT_MS } from "../sqlite/sqlite.constants";

/**
 * Переводит отказ получения или подтверждения mutex в диагностику, сохраняя исходную причину.
 */
function lockError(error: unknown, path: string): RelayError {
  if (error instanceof RelayError) {
    return error;
  }
  const code = errorCode(error);
  let converted: RelayError;
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    converted = new RelayError("WORKSPACE_BUSY", localLockMessages.busy, 4, {
      path,
    });
  } else {
    converted = new RelayError("STORAGE_ERROR", localLockMessages.lockFailed, 1, {
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  converted.cause = error;
  return converted;
}

/**
 * Выполняет синхронную критическую секцию read-modify-write локального JSON под SQLite mutex.
 * Mutex привязан к пути: вызывающий заранее разрешает символьные ссылки в единый физический путь.
 * Родительский каталог должен существовать; занятый mutex даёт WORKSPACE_BUSY после ожидания SQLite.
 * Атомарную замену JSON выполняет вызывающий; исключение освобождает mutex, но не откатывает JSON.
 * Async-функция не запускается, thenable отклоняется. Файл mutex остаётся, соединение всегда закрывается.
 */
export function withLocalFileLock<T>(path: string, operation: SynchronousOperation<T>): T {
  if (isAsyncFunction(operation)) {
    throw new RelayError("ASYNC_TRANSACTION", localLockMessages.asyncCallback);
  }
  path = resolve(path);
  const lockPath = `${path}.lock.sqlite`;
  let connection: Database | undefined;
  try {
    try {
      connection = new Database(lockPath, { create: true, readwrite: true, strict: true });
      connection.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; BEGIN IMMEDIATE;`);
    } catch (error) {
      throw lockError(error, path);
    }
    // Файл остаётся на месте: mutex принадлежит соединению SQLite, ОС снимает его и после SIGKILL.
    // Удаление файла здесь создало бы второй inode и позволило двум процессам войти одновременно.
    const result = operation();
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new RelayError("ASYNC_TRANSACTION", localLockMessages.asyncResult);
    }
    try {
      connection.exec("COMMIT");
    } catch (error) {
      throw lockError(error, path);
    }
    return result;
  } finally {
    if (connection) {
      try {
        if (connection.inTransaction) {
          connection.exec("ROLLBACK");
        }
      } finally {
        connection.close();
      }
    }
  }
}
