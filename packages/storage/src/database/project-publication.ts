import type { Database } from "bun:sqlite";
import { RelayError } from "@relay/contracts";
import { connectProjectFile } from "./project-file";
import type { JournalModeRow } from "./project-database.types";
import { projectDatabaseMessages } from "./project-database.messages";
import { errorCode, storageError } from "../sqlite/sqlite-errors";
import { isAsyncFunction } from "../sqlite/transaction-callback";

/**
 * Сообщает об отсутствии эксклюзивного владения SQLite без удаления файлов или повторных попыток.
 */
function publicationBusy(path: string, cause?: unknown): RelayError {
  const error = new RelayError(
    "DATABASE_PUBLICATION_BUSY",
    projectDatabaseMessages.publicationBusy,
    4,
    { path },
  );
  error.cause = cause;
  return error;
}

/**
 * Завершает WAL средствами SQLite и закрывает соединение до создания второго имени.
 * journal_mode=DELETE требует эксклюзивного доступа, переносит принятые WAL-frames в datafile
 * и убирает journals даже при persistent WAL. Живой WAL-reader/writer запрещает переход.
 */
function sealPrivateDatabase(path: string): void {
  const connection = connectProjectFile(path);
  try {
    connection.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL");
    const mode = connection.query<JournalModeRow, []>("PRAGMA journal_mode=DELETE").get();
    if (mode?.journal_mode !== "delete") {
      throw publicationBusy(path);
    }
  } finally {
    connection.close(true);
  }
}

/**
 * Публикует только private staging, которым эксклюзивно владеет вызывающий: публичных имён ещё нет,
 * все materializer/validator соединения закрыты, отложенные открытия staging запрещены.
 * Переход WAL → DELETE и закрытие выполняются до callback. Затем новая неизменяющая EXCLUSIVE
 * транзакция повторно проверяет DELETE: открытие writer в промежутке не создаёт TOCTOU-разрешения.
 * Callback строго синхронен и только создаёт hardlink; SQLite-lock удерживается до его завершения.
 * После link выполняются лишь откат пустой транзакции и close, без записи по прежнему имени.
 * Ошибка callback не откатывает его файловые эффекты. К уже опубликованной БД API неприменим.
 */
export function withProjectDatabasePublication(path: string, publish: () => void): void {
  if (isAsyncFunction(publish)) {
    throw new RelayError("INVALID_ARGUMENT", projectDatabaseMessages.publicationSynchronous, 2);
  }
  let connection: Database | undefined;
  let publishing = false;
  try {
    sealPrivateDatabase(path);
    connection = connectProjectFile(path);
    connection.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    const mode = connection.query<JournalModeRow, []>("PRAGMA journal_mode").get();
    if (mode?.journal_mode !== "delete") {
      throw publicationBusy(path);
    }
    publishing = true;
    const result: unknown = publish();
    if (result !== undefined) {
      if (result instanceof Promise) {
        void result.catch(() => {});
      }
      throw new RelayError("INVALID_ARGUMENT", projectDatabaseMessages.publicationSynchronous, 2);
    }
  } catch (cause) {
    if (publishing) {
      throw cause;
    }
    const code = errorCode(cause);
    if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
      throw publicationBusy(path, cause);
    }
    throw storageError(cause, path);
  } finally {
    if (connection) {
      try {
        if (connection.inTransaction) {
          connection.exec("ROLLBACK");
        }
      } finally {
        connection.close(true);
      }
    }
  }
}
