import { mkdtempSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase, withProjectDatabasePublication } from "@relay/storage";
import { fileExists } from "../configuration/files";
import type { ProjectLocation } from "./location.types";
import { projectMessages } from "./project.messages";
import { restorationMessages } from "./restoration.messages";
import { requireSynchronousRestorationCallback } from "./restoration-callback";
import {
  observeRestorationFile,
  requireNoRestorationJournals,
  restorationOwnershipError,
  sameRestorationFile,
} from "./restoration-ownership";
import type { RestorationFileIdentity } from "./restoration-ownership.types";

/**
 * Проверяет текущую схему и постоянный ID без миграций/включения WAL; закрывает readonly-соединение.
 * Для живого опубликованного проекта вызывающий передаёт исключительно публичный путь.
 */
export function validateRestorationDatabase(path: string, location: ProjectLocation): void {
  const database = ProjectDatabase.openReadonly(path);
  try {
    if (database.projectId !== location.projectId) {
      throw new RelayError(
        "PROJECT_ID_MISMATCH",
        projectMessages.projectIdMismatch(location.configPath),
        4,
        {
          configPath: location.configPath,
          expected: location.projectId,
          actual: database.projectId,
        },
      );
    }
  } finally {
    database.close();
  }
}

/**
 * Наблюдает единственное private-имя обычного файла без symlink и неизвестных hardlink-алиасов.
 * Принадлежность staging-каталога до вызова доказывает fresh restore либо проверка intent resume.
 */
export function requirePrivateRestorationFile(path: string): RestorationFileIdentity {
  const file = observeRestorationFile(path);
  if (file.links !== 1n) {
    throw restorationOwnershipError(path);
  }
  return file.identity;
}

/**
 * Сохраняет идентичности и путь изолированного SHM при подмене; файл не удаляется.
 */
function changedPrivateShm(
  path: string,
  expected: RestorationFileIdentity | null,
  actual: RestorationFileIdentity,
  retainedPath?: string,
): RelayError {
  return new RelayError("RESTORE_RECOVERY_REQUIRED", restorationMessages.ownership, 4, {
    path,
    reason: "staging-shm-changed",
    expected,
    actual,
    ...(retainedPath ? { retainedPath } : {}),
  });
}

/**
 * Под удерживаемым DELETE/EXCLUSIVE-барьером убирает только ранее наблюдённый private SHM.
 * Его инертность следует из режима SQLite и блокировки, а не из inode или размера: WAL/journal
 * запрещены, datafile и индекс не имеют других имён. SQLite-писатель не может использовать этот
 * индекс до освобождения main-file lock. Перед unlink индекс атомарно изолируется в собственном
 * новом каталоге и повторно сверяется: подмена исходного имени между stat/rename не удаляет чужой файл.
 * При неопределённости изолированный файл сохраняется; crash может оставить companion для ручной проверки.
 */
function cleanupSealedPrivateShm(path: string, expected: RestorationFileIdentity | null): void {
  requireNoRestorationJournals(path, "sealed-private");
  const shmPath = `${path}-shm`;
  if (!fileExists(shmPath)) {
    return;
  }
  const actual = requirePrivateRestorationFile(shmPath);
  if (!expected || !sameRestorationFile(expected, actual)) {
    throw changedPrivateShm(shmPath, expected, actual);
  }
  try {
    const retiredDirectory = mkdtempSync(join(dirname(path), ".restore-shm-"));
    const retiredPath = join(retiredDirectory, "index");
    renameSync(shmPath, retiredPath);
    const retiredIdentity = requirePrivateRestorationFile(retiredPath);
    if (!sameRestorationFile(expected, retiredIdentity)) {
      throw changedPrivateShm(shmPath, expected, retiredIdentity, retiredPath);
    }
    unlinkSync(retiredPath);
    rmdirSync(retiredDirectory);
  } catch (cause) {
    if (cause instanceof RelayError) {
      throw cause;
    }
    throw restorationOwnershipError(shmPath, cause);
  }
}

/**
 * Передаёт Storage принадлежащий вызывающему private staging и синхронную публикацию под SQLite-lock.
 * До и внутри барьера сверяет точную идентичность единственного datafile. Остаточный SHM разрешён
 * только как ранее наблюдённый неалиасный private-индекс: он очищается под барьером до публикации имени.
 * WAL/journal не удаляются через fs; публичный target и его companions сюда не передаются.
 * Async callback отвергается до файловых эффектов; результат publish передаётся строгой проверке
 * Storage. Отказ проверки результата не откатывает уже выполненные файловые эффекты публикации.
 * Занятость сохраняет прежний Runtime-код; остальные причины и файловые эффекты callback не подменяются.
 */
export function withRestorationDatabasePublication(path: string, publish: () => void): void {
  requireSynchronousRestorationCallback(publish, restorationMessages.synchronousPublication);
  const databaseIdentity = requirePrivateRestorationFile(path);
  const shmIdentity = fileExists(`${path}-shm`)
    ? requirePrivateRestorationFile(`${path}-shm`)
    : null;
  try {
    withProjectDatabasePublication(path, () => {
      if (!sameRestorationFile(databaseIdentity, requirePrivateRestorationFile(path))) {
        throw restorationOwnershipError(path);
      }
      cleanupSealedPrivateShm(path, shmIdentity);
      return publish();
    });
  } catch (cause) {
    if (!(cause instanceof RelayError && cause.code === "DATABASE_PUBLICATION_BUSY")) {
      throw cause;
    }
    const error = new RelayError("RESTORE_DATABASE_OPEN", projectMessages.restoreDatabaseOpen, 4, {
      path,
    });
    error.cause = cause;
    throw error;
  }
}
