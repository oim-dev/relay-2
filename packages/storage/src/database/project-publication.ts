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
 * и завершает WAL. Живой WAL-reader/writer запрещает переход. Физический SHM-индекс может
 * остаться на диске после close; в DELETE он не используется и не является журналом данных.
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
 * Переход WAL → DELETE и закрытие выполняются до callback. Новое соединение получает EXCLUSIVE
 * locking_mode и пустой BEGIN EXCLUSIVE, проверяет DELETE и завершает транзакцию до callback.
 * EXCLUSIVE locking_mode удерживает main-file lock до close, в том числе после ROLLBACK.
 * Наличие остаточного SHM не отменяет барьер; владение и очистка файлов принадлежат вызывающему.
 * Callback синхронно завершает private-file подготовку и публикует имя, не меняя datafile.
 * Допускается no-replace rename: после callback соединение только закрывается, SQL больше нет.
 * Callback не открывает/закрывает посторонние FD datafile или его hardlink: на POSIX такой close
 * снимает процессные fcntl-locks. Файловое чтение datafile допустимо только после завершения барьера.
 * После публикации нет транзакции, journal или SQL, использующих прежнее имя; чужие соединения не закрываются.
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
    connection.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    const mode = connection.query<JournalModeRow, []>("PRAGMA journal_mode").get();
    if (mode?.journal_mode !== "delete") {
      throw publicationBusy(path);
    }
    connection.exec("ROLLBACK");
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
    connection?.close(true);
  }
}
