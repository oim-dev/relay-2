import { linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { withLocalFileLock } from "@relay/storage";
import { fileExists, withFileErrors, writeJsonAtomic } from "../configuration/files";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import type { ProjectLocation } from "./location.types";
import {
  validateRestorationDatabase,
  withRestorationDatabasePublication,
} from "./restoration-database";
import {
  observeRestorationFile,
  requireNoRestorationJournals,
  restorationOwnershipError,
} from "./restoration-ownership";
import { projectMessages as messages } from "./project.messages";
import {
  selectRestorationTarget,
  requireMatchingRestorationConfig,
  validateRestorationProjectId,
} from "./restoration-target";
import {
  invokeRestorationCallback,
  requireSynchronousRestorationCallback,
} from "./restoration-callback";
import {
  beginRestorationPublication,
  finishRestorationPublication,
  requireNoPendingRestoration,
  restorationPublicationError,
} from "./restoration-publication";

/**
 * Запрещает публикацию поверх БД и её отдельных журналов, в том числе появившихся во время materializer.
 */
function requireVacantDatabase(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (fileExists(`${databasePath}${suffix}`)) {
      throw new RelayError("DATABASE_EXISTS", messages.restoreDatabaseExists, 4, {
        databasePath,
      });
    }
  }
}

/**
 * Материализует проверенный приложением portable snapshot в новую независимую локальную реплику.
 * Callback строго синхронен, создаёт SQLite в переданном staging-пути и закрывает все соединения.
 * Runtime проверяет совместимость/ID, эксклюзивно публикует БД и затем конфиг; готовая БД/WAL/SHM не заменяются.
 * До intent ошибка убирает приватный staging. После начала публикации БД никогда не удаляется:
 * отказ сохраняет staging/intent и даёт RESTORE_RECOVERY_REQUIRED с расположением recovery-материалов.
 * Прежний intent также даёт эту ошибку до callback, без автоматического resume/adoption: успешный
 * ProjectLocation относится только к материализации текущего вызова, а не к старому fetched snapshot.
 */
export function restoreProject(
  options: RuntimeOptions,
  projectId: string,
  writeDatabase: (databasePath: string) => void,
): ProjectLocation {
  return withFileErrors(() => {
    requireSynchronousRestorationCallback(writeDatabase, messages.restoreSynchronous);
    validateRestorationProjectId(projectId);
    const { location, existingConfig } = selectRestorationTarget(options, projectId);
    const directory = dirname(location.databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return withLocalFileLock(join(directory, ".restore"), () => {
      requireNoPendingRestoration(location);
      requireVacantDatabase(location.databasePath);
      const staging = mkdtempSync(join(directory, ".restore-"));
      const stagedDatabase = join(staging, "project.sqlite");
      let publicationStarted = false;
      let committed = false;
      try {
        invokeRestorationCallback(writeDatabase, stagedDatabase, messages.restoreSynchronous);
        if (observeRestorationFile(stagedDatabase).links !== 1n) {
          throw restorationOwnershipError(stagedDatabase);
        }
        validateRestorationDatabase(stagedDatabase, location);
        if (existingConfig) {
          requireMatchingRestorationConfig(location, options);
        }
        requireVacantDatabase(location.databasePath);
        withRestorationDatabasePublication(stagedDatabase, () => {
          if (observeRestorationFile(stagedDatabase).links !== 1n) {
            throw restorationOwnershipError(stagedDatabase);
          }
          requireNoRestorationJournals(stagedDatabase);
          requireVacantDatabase(location.databasePath);
          beginRestorationPublication(location, staging);
          publicationStarted = true;
          // Пустая DELETE-транзакция удерживает SQLite-lock до создания нового имени.
          linkSync(stagedDatabase, location.databasePath);
        });
        if (!existingConfig) {
          mkdirSync(dirname(resolve(location.configPath)), { recursive: true });
          writeJsonAtomic(location.configPath, { version: 1, projectId }, "create");
        }
        committed = true;
        return location;
      } catch (error) {
        if (publicationStarted) {
          throw restorationPublicationError(location, staging, "publication-failed", error);
        }
        throw error;
      } finally {
        if (committed) {
          finishRestorationPublication(location, staging);
        } else if (!publicationStarted) {
          rmSync(staging, { recursive: true, force: true });
        }
      }
    });
  });
}
