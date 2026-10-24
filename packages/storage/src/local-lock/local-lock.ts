import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { localLockMessages } from "./local-lock.messages";
import { errorCode } from "../sqlite/sqlite-errors";
import { isAsyncFunction, isPromiseLike } from "../sqlite/transaction-callback";
import type { SynchronousOperation } from "../sqlite/transaction.types";
import { SQLITE_BUSY_TIMEOUT_MS } from "../sqlite/sqlite.constants";
import type { LocalLock, LocalLockOptions } from "./local-lock.types";

/**
 * Переводит отказ получения или подтверждения mutex в диагностику, сохраняя исходную причину.
 */
function lockError(error: unknown, path: string, owned = false): RelayError {
  if (error instanceof RelayError) {
    return error;
  }
  const code = errorCode(error);
  let converted: RelayError;
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    converted = new RelayError(
      owned ? "LOCAL_LOCK_BUSY" : "WORKSPACE_BUSY",
      owned ? localLockMessages.ownedBusy : localLockMessages.busy,
      4,
      {
        path,
      },
    );
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
 * Получает межпроцессный mutex на отдельном SQLite-файле с явным временем владения.
 * path — сам lock-файл; caller заранее канонизирует путь и создаёт родительский каталог.
 * Соединение удерживает BEGIN IMMEDIATE до release, допускает await между получением и освобождением.
 * Занятость даёт LOCAL_LOCK_BUSY; ОС освобождает mutex после crash/SIGKILL, файл никогда не удаляется.
 */
export function acquireLocalLock(path: string, options: LocalLockOptions = {}): LocalLock {
  const timeout = options.timeoutMs ?? 0;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 300000) {
    throw new RelayError("INVALID_ARGUMENT", localLockMessages.invalidTimeout, 2);
  }
  path = resolve(path);
  let connection: Database | undefined;
  try {
    connection = new Database(path, { create: true, readwrite: true, strict: true });
    connection.exec(`PRAGMA busy_timeout=${timeout}; BEGIN IMMEDIATE;`);
  } catch (error) {
    connection?.close();
    throw lockError(error, path, true);
  }
  const owned = connection;
  let released = false;
  return {
    /**
     * Завершает владение отдельным mutex-соединением; повторный вызов не меняет состояние.
     */
    release(): void {
      if (released) {
        return;
      }
      released = true;
      try {
        if (owned.inTransaction) {
          owned.exec("ROLLBACK");
        }
      } catch (error) {
        throw lockError(error, path, true);
      } finally {
        owned.close();
      }
    },
  };
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
