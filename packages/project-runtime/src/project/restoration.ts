import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { withLocalFileLock } from "@relay/storage";
import { fileExists, withFileErrors, writeJsonAtomic } from "../configuration/files";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import type { ProjectLocation } from "./location.types";
import {
  validateRestorationDatabase,
  withRestorationDatabasePublication,
  requirePrivateRestorationFile,
} from "./restoration-database";
import {
  requireNoRestorationJournals,
  requirePublishedRestorationDatabase,
  observeRestorationFile,
  restorationOwnershipError,
  sameRestorationFile,
} from "./restoration-ownership";
import { transferRestorationDatabase } from "./restoration-transfer";
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
 * До intent обычная ошибка убирает приватный staging; сомнительное владение/занятость сохраняют его.
 * После начала публикации БД никогда не удаляется:
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
      let preserveStaging = false;
      try {
        invokeRestorationCallback(writeDatabase, stagedDatabase, messages.restoreSynchronous);
        const databaseIdentity = requirePrivateRestorationFile(stagedDatabase);
        if (fileExists(`${stagedDatabase}-shm`)) {
          // Даже readonly WAL-открытие может менять индекс: чужой SHM нельзя передавать SQLite.
          requirePrivateRestorationFile(`${stagedDatabase}-shm`);
        }
        validateRestorationDatabase(stagedDatabase, location);
        if (existingConfig) {
          requireMatchingRestorationConfig(location, options);
        }
        requireVacantDatabase(location.databasePath);
        withRestorationDatabasePublication(stagedDatabase, () => {
          requirePrivateRestorationFile(stagedDatabase);
          requireNoRestorationJournals(stagedDatabase);
          requireVacantDatabase(location.databasePath);
          const publication = beginRestorationPublication(location, staging);
          publicationStarted = true;
          transferRestorationDatabase(publication);
          requirePublishedRestorationDatabase(publication);
        });
        if (!existingConfig) {
          mkdirSync(dirname(resolve(location.configPath)), { recursive: true });
          writeJsonAtomic(location.configPath, { version: 1, projectId }, "create");
        }
        if (
          !sameRestorationFile(
            databaseIdentity,
            observeRestorationFile(location.databasePath).identity,
          )
        ) {
          throw restorationOwnershipError(location.databasePath);
        }
        committed = true;
        return location;
      } catch (error) {
        if (publicationStarted) {
          throw restorationPublicationError(location, staging, "publication-failed", error);
        }
        preserveStaging =
          error instanceof RelayError &&
          (error.code === "RESTORE_RECOVERY_REQUIRED" || error.code === "RESTORE_DATABASE_OPEN");
        throw error;
      } finally {
        if (committed) {
          finishRestorationPublication(location, staging);
        } else if (!publicationStarted && !preserveStaging) {
          rmSync(staging, { recursive: true, force: true });
        }
      }
    });
  });
}
