import { closeSync, fsyncSync, linkSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";
import { fileExists } from "../configuration/files";
import type { ProjectLocation } from "./location.types";
import type {
  RestorationPublication,
  RestorationRecoveryDetails,
  CurrentRestorationPublication,
} from "./restoration-publication.types";
import { projectMessages as messages } from "./project.messages";
import {
  isRestorationFileIdentity,
  observeRestorationFile,
  RESTORATION_STAGING_MARKER,
  cleanupResumedRestoration,
} from "./restoration-ownership";
import { restorationTransfer } from "./restoration-transfer";

const PUBLICATION_FILE = ".restore-publication.json";

/**
 * Возвращает точный путь intent выбранной БД, без поиска других проектов home.
 */
export function restorationPublicationPath(location: ProjectLocation): string {
  return join(dirname(location.databasePath), PUBLICATION_FILE);
}

/**
 * Сохраняет путь и исходную причину непрочитанного/несовместимого intent без разрешения на cleanup.
 */
function invalidPublication(path: string, cause?: unknown): RelayError {
  const error = new RelayError("RESTORE_RECOVERY_REQUIRED", messages.restoreRecoveryRequired, 4, {
    path,
  });
  error.cause = cause;
  return error;
}

/**
 * Читает только принадлежащее этому расположению намерение; повреждение не разрешает удалять файлы.
 */
export function readRestorationPublication(
  location: ProjectLocation,
): RestorationPublication | null {
  const path = restorationPublicationPath(location);
  if (!fileExists(path)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw invalidPublication(path, cause);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !("projectId" in value) ||
    value.projectId !== location.projectId ||
    !("configPath" in value) ||
    value.configPath !== location.configPath ||
    !("databasePath" in value) ||
    value.databasePath !== location.databasePath ||
    !("staging" in value) ||
    typeof value.staging !== "string" ||
    dirname(value.staging) !== dirname(location.databasePath) ||
    !basename(value.staging).startsWith(".restore-")
  ) {
    throw invalidPublication(path);
  }
  const paths = {
    projectId: location.projectId,
    configPath: location.configPath,
    databasePath: location.databasePath,
    staging: value.staging,
  };
  if (value.version === 1) {
    return { version: 1, ...paths };
  }
  if (!("databaseIdentity" in value) || !isRestorationFileIdentity(value.databaseIdentity)) {
    throw invalidPublication(path);
  }
  if (value.version === 2) {
    return { version: 2, ...paths, databaseIdentity: value.databaseIdentity };
  }
  if (
    !("transfer" in value) ||
    (value.transfer !== "rename" && value.transfer !== "hardlink") ||
    !("markerIdentity" in value) ||
    !isRestorationFileIdentity(value.markerIdentity)
  ) {
    throw invalidPublication(path);
  }
  return {
    version: 3,
    ...paths,
    databaseIdentity: value.databaseIdentity,
    markerIdentity: value.markerIdentity,
    transfer: value.transfer,
  };
}

/**
 * Эксклюзивно публикует fsync-нутый v3 marker до переноса datafile; вызывающий удерживает restore mutex.
 * Старые readers v1/v2 отвергают новый intent до попытки восстановить прежний private hardlink.
 */
export function beginRestorationPublication(
  location: ProjectLocation,
  staging: string,
): CurrentRestorationPublication {
  const temporary = join(staging, RESTORATION_STAGING_MARKER);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    const value: CurrentRestorationPublication = {
      version: 3,
      projectId: location.projectId,
      configPath: location.configPath,
      databasePath: location.databasePath,
      staging,
      databaseIdentity: observeRestorationFile(join(staging, "project.sqlite")).identity,
      markerIdentity: observeRestorationFile(temporary).identity,
      transfer: restorationTransfer(),
    };
    writeFileSync(descriptor, JSON.stringify(value), "utf8");
    fsyncSync(descriptor);
    linkSync(temporary, restorationPublicationPath(location));
    return value;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * После успешной публикации БД и config убирает только собственные staging и intent.
 * Не вызывается при отказе или неопределённости: staging может быть последней ссылкой на принятую БД.
 * Ошибка уборки после commit не отменяет готовую рабочую БД.
 */
export function finishRestorationPublication(location: ProjectLocation, staging: string): void {
  try {
    const publication = readRestorationPublication(location);
    if (publication?.staging === staging) {
      cleanupResumedRestoration(publication, restorationPublicationPath(location));
    }
  } catch {
    // Маркер остаётся для следующего восстановления; пользовательская БД не откатывается из-за уборки.
  }
}

/**
 * Формирует явный recovery-исход без изменения файлов. Ни inode, ни отсутствие WAL не дают права
 * откатить опубликованную БД: другой writer мог принять запись и закрыть соединение.
 * Полная причина текущего отказа сохраняется в cause, её диагностика — в переносимых details.
 */
export function restorationPublicationError(
  location: ProjectLocation,
  staging: string,
  reason: RestorationRecoveryDetails["reason"],
  cause?: unknown,
): RelayError {
  const details: RestorationRecoveryDetails = {
    reason,
    location: { ...location },
    stagingPath: staging,
    publicationPath: restorationPublicationPath(location),
    materializedInCurrentCall: reason === "publication-failed",
    ...(cause === undefined
      ? {}
      : {
          sourceError: {
            code: cause instanceof RelayError ? cause.code : "IO_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        }),
  };
  const failure = new RelayError("RESTORE_RECOVERY_REQUIRED", messages.restoreRecoveryRequired, 4, {
    ...details,
  });
  failure.cause = cause;
  return failure;
}

/**
 * Не позволяет повтору restore удалить или молча принять БД незавершённой попытки.
 * Даже без рабочего пути staging мог стать последней ссылкой на БД с поздними принятыми записями.
 * Сохраняет все файлы и возвращает RESTORE_RECOVERY_REQUIRED до запуска нового materializer.
 * Для явной привязки сохранённого состояния служит отдельный resumeProjectRestoration с validator Core.
 */
export function requireNoPendingRestoration(location: ProjectLocation): void {
  const previous = readRestorationPublication(location);
  if (previous) {
    throw restorationPublicationError(location, previous.staging, "pending-publication");
  }
}
