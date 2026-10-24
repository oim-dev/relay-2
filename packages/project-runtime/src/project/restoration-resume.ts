import { linkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";
import { withLocalFileLock } from "@relay/storage";
import { fileExists, withFileErrors, writeJsonAtomic } from "../configuration/files";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import type { ProjectLocation } from "./location.types";
import { readProjectLocation } from "./selection";
import { defaultProjectDatabasePath } from "./database-path";
import { requireMatchingRestorationConfig, selectRestorationTarget } from "./restoration-target";
import {
  invokeRestorationCallback,
  requireSynchronousRestorationCallback,
} from "./restoration-callback";
import { readRestorationPublication, restorationPublicationPath } from "./restoration-publication";
import type { RestorationPublication } from "./restoration-publication.types";
import type { RestorationResumeResult } from "./restoration-resume.types";
import { restorationMessages } from "./restoration.messages";
import {
  cleanupResumedRestoration,
  observeRestorationFile,
  requireNoRestorationJournals,
  requireRestorationDatabaseLink,
  requireRestorationOwnership,
  restorationOwnershipError,
} from "./restoration-ownership";

/**
 * Требует явный intent именно выбранных ID/config/БД; отсутствие не превращается в adoption обычного проекта.
 */
function requirePendingPublication(location: ProjectLocation): RestorationPublication {
  const publication = readRestorationPublication(location);
  if (!publication) {
    throw new RelayError("RESTORE_NOT_PENDING", restorationMessages.notPending, 3, { location });
  }
  return publication;
}

/**
 * Для отсутствующего target требует закрытую staging-БД без журналов и неизвестных hardlink-алиасов.
 * Нельзя читать staging, пока живой writer мог оставлять WAL по прежнему публичному имени.
 */
function requireQuiescentStaging(publication: RestorationPublication): void {
  const stagedPath = join(publication.staging, "project.sqlite");
  requireNoRestorationJournals(publication.databasePath);
  requireNoRestorationJournals(stagedPath);
  if (fileExists(publication.databasePath) || observeRestorationFile(stagedPath).links !== 1n) {
    throw restorationOwnershipError(stagedPath);
  }
}

/**
 * Проверяет схему/ID и предметное состояние через строго синхронный read-only callback.
 * Живой target проверяется только под публичным именем; staging открывается лишь без target/journals.
 * Callback обязан закрыть свои соединения и не запускать отложенные writers.
 */
function validatePreservedDatabase(
  publication: RestorationPublication,
  location: ProjectLocation,
  options: RuntimeOptions,
  validateDatabase: (path: string) => void,
): void {
  const markerPath = restorationPublicationPath(location);
  requireRestorationOwnership(publication, markerPath);
  const stagedPath = join(publication.staging, "project.sqlite");
  requireNoRestorationJournals(stagedPath);
  const publicTarget = fileExists(location.databasePath);
  if (publicTarget) {
    requireRestorationDatabaseLink(publication);
  } else {
    requireQuiescentStaging(publication);
  }
  const validationPath = publicTarget ? location.databasePath : stagedPath;
  readProjectLocation(
    location.configPath,
    { version: 1, projectId: location.projectId, databasePath: validationPath },
    options,
  );
  invokeRestorationCallback(
    validateDatabase,
    validationPath,
    restorationMessages.synchronousValidator,
  );
  requireRestorationOwnership(publication, markerPath);
  requireNoRestorationJournals(stagedPath);
  if (publicTarget) {
    requireRestorationDatabaseLink(publication);
    return;
  }
  requireQuiescentStaging(publication);
  // Только новый hardlink: даже занявший путь в этой точке чужой файл не заменяется.
  try {
    linkSync(stagedPath, location.databasePath);
  } catch (cause) {
    throw restorationOwnershipError(location.databasePath, cause);
  }
  requireRestorationDatabaseLink(publication);
}

/**
 * Сохраняет совпадающий config дословно либо эксклюзивно публикует отсутствующий.
 * Победившая конкурентная публикация допускается только при том же ID и точном пути БД.
 */
function publishResumedConfiguration(location: ProjectLocation, options: RuntimeOptions): void {
  if (fileExists(location.configPath)) {
    requireMatchingRestorationConfig(location, options);
    return;
  }
  mkdirSync(dirname(location.configPath), { recursive: true });
  try {
    writeJsonAtomic(
      location.configPath,
      {
        version: 1,
        projectId: location.projectId,
        ...(location.databasePath === defaultProjectDatabasePath(options, location.projectId)
          ? {}
          : { databasePath: location.databasePath }),
      },
      "create",
    );
  } catch (error) {
    if (!(error instanceof RelayError && error.code === "CONFIG_EXISTS")) {
      throw error;
    }
    requireMatchingRestorationConfig(location, options);
  }
}

/**
 * Явно завершает сохранённую публикацию без fetch, materializer, bootstrap или подтверждения remote HEAD.
 * ID берётся из совпадающего config либо явного projectId; home не сканируется. Чужая/сомнительная
 * идентичность и незакрытая staging-БД отвергаются без удаления файлов. Validator синхронно читает
 * согласованное предметное состояние через Core и закрывает соединения; мутации ему запрещены.
 * После успешной привязки удаляются только доказанные private links/intent; публичная БД не удаляется.
 * Незавершённая уборка отражается в recovery. Повтор после полной уборки даёт RESTORE_NOT_PENDING.
 */
export function resumeProjectRestoration(
  options: RuntimeOptions,
  projectId: string | undefined,
  validateDatabase: (path: string) => void,
): RestorationResumeResult {
  return withFileErrors(() => {
    requireSynchronousRestorationCallback(
      validateDatabase,
      restorationMessages.synchronousValidator,
    );
    const { location } = selectRestorationTarget(options, projectId);
    // Не создаём каталог/lock при отсутствии intent и не сканируем другие проекты.
    requirePendingPublication(location);
    return withLocalFileLock(
      join(dirname(location.databasePath), ".restore"),
      (): RestorationResumeResult => {
        const publication = requirePendingPublication(location);
        validatePreservedDatabase(publication, location, options, validateDatabase);
        publishResumedConfiguration(location, options);
        requireMatchingRestorationConfig(location, options);
        const markerPath = restorationPublicationPath(location);
        const cleanupFailure = cleanupResumedRestoration(publication, markerPath);
        return {
          location,
          resumed: true,
          preservedExisting: true,
          sourceCheckpoint: null,
          recovery: cleanupFailure
            ? {
                publicationPath: markerPath,
                stagingPath: publication.staging,
                failure: cleanupFailure,
              }
            : null,
        };
      },
    );
  });
}
