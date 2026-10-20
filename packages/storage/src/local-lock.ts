import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { RelayError } from "@relay/contracts";

function lockError(error: unknown, path: string): unknown {
  if (error instanceof RelayError) return error;
  const code = (error as { code?: string } | null)?.code ?? "";
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return new RelayError("WORKSPACE_BUSY", "Workspace занят другой операцией записи.", 4, {
      path,
    });
  }
  return new RelayError("STORAGE_ERROR", "Не удалось заблокировать локальный файл.", 1, {
    path,
    reason: error instanceof Error ? error.message : String(error),
  });
}

/** Синхронная критическая секция для read-modify-write JSON; атомарную замену JSON выполняет вызывающий. */
export function withLocalFileLock<T>(
  path: string,
  operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  if (Object.prototype.toString.call(operation) === "[object AsyncFunction]") {
    throw new RelayError("ASYNC_TRANSACTION", "Блокировка принимает только синхронную функцию.");
  }
  path = resolve(path);
  const lockPath = `${path}.lock.sqlite`;
  let connection: Database | undefined;
  try {
    try {
      connection = new Database(lockPath, { create: true, readwrite: true, strict: true });
      connection.exec("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE;");
    } catch (error) {
      throw lockError(error, path);
    }
    // Файл остаётся на месте: mutex принадлежит соединению SQLite, ОС снимает его и после SIGKILL.
    // Удаление файла здесь создало бы второй inode и позволило двум процессам войти одновременно.
    const result = operation();
    if (result != null && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new RelayError(
        "ASYNC_TRANSACTION",
        "Операция под блокировкой не может возвращать Promise.",
      );
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
        if (connection.inTransaction) connection.exec("ROLLBACK");
      } finally {
        connection.close();
      }
    }
  }
}
