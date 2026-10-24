import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { fileExists } from "../configuration/files";
import { projectMessages } from "./project.messages";
import { restorationMessages } from "./restoration.messages";
import type { RestorationPublication } from "./restoration-publication.types";
import type {
  RestorationCleanupFailure,
  RestorationFileIdentity,
  RestorationFileObservation,
} from "./restoration-ownership.types";

export const RESTORATION_STAGING_MARKER = "publication.json";

/**
 * Отказывает без удаления файлов при отсутствии доказанного владения; сохраняет системную причину.
 */
export function restorationOwnershipError(path: string, cause?: unknown): RelayError {
  const error = new RelayError("RESTORE_RECOVERY_REQUIRED", restorationMessages.ownership, 4, {
    path,
  });
  error.cause = cause;
  return error;
}

/**
 * Декодирует сохранённую физическую идентичность; неизвестные/усечённые числа не принимаются.
 */
export function isRestorationFileIdentity(value: unknown): value is RestorationFileIdentity {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "device" in value &&
    typeof value.device === "string" &&
    /^(0|[1-9]\d*)$/u.test(value.device) &&
    "inode" in value &&
    typeof value.inode === "string" &&
    /^[1-9]\d*$/u.test(value.inode) &&
    "birthtimeNs" in value &&
    typeof value.birthtimeNs === "string" &&
    /^[1-9]\d*$/u.test(value.birthtimeNs)
  );
}

/**
 * Наблюдает только обычный файл, без следования symlink и без потери точности inode на Windows.
 * ФС без надёжного inode/времени создания не даёт достаточного основания для безопасного resume.
 */
export function observeRestorationFile(path: string): RestorationFileObservation {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (
      !stat.isFile() ||
      typeof stat.dev !== "bigint" ||
      typeof stat.ino !== "bigint" ||
      typeof stat.nlink !== "bigint" ||
      typeof stat.birthtimeNs !== "bigint" ||
      stat.dev < 0n ||
      stat.ino <= 0n ||
      stat.nlink < 1n ||
      stat.birthtimeNs <= 0n
    ) {
      throw restorationOwnershipError(path);
    }
    return {
      identity: {
        device: String(stat.dev),
        inode: String(stat.ino),
        birthtimeNs: String(stat.birthtimeNs),
      },
      links: stat.nlink,
    };
  } catch (cause) {
    if (cause instanceof RelayError) {
      throw cause;
    }
    throw restorationOwnershipError(path, cause);
  }
}

/**
 * Сравнивает физический файл, а не его изменяемое содержимое; поздние commits остаются допустимыми.
 */
export function sameRestorationFile(
  left: RestorationFileIdentity,
  right: RestorationFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

/**
 * Проверяет private directory, hardlink пары маркеров и исходную идентичность staging-БД.
 * Старый intent v1 сохраняется, но не даёт разрешения на resume/cleanup.
 */
export function requireRestorationOwnership(
  publication: RestorationPublication,
  markerPath: string,
): void {
  try {
    if (!lstatSync(publication.staging).isDirectory()) {
      throw restorationOwnershipError(publication.staging);
    }
    const marker = observeRestorationFile(markerPath);
    const privateMarker = observeRestorationFile(
      join(publication.staging, RESTORATION_STAGING_MARKER),
    );
    if (marker.links < 2n || !sameRestorationFile(marker.identity, privateMarker.identity)) {
      throw restorationOwnershipError(markerPath);
    }
    const stagedPath = join(publication.staging, "project.sqlite");
    const staged = observeRestorationFile(stagedPath);
    if (
      publication.version !== 2 ||
      !sameRestorationFile(staged.identity, publication.databaseIdentity)
    ) {
      throw restorationOwnershipError(stagedPath);
    }
  } catch (cause) {
    if (cause instanceof RelayError) {
      throw cause;
    }
    throw restorationOwnershipError(publication.staging, cause);
  }
}

/**
 * Принимает только исходный опубликованный hardlink; чужой файл даже того же projectId сохраняется и отвергается.
 */
export function requireRestorationDatabaseLink(publication: RestorationPublication): void {
  const target = observeRestorationFile(publication.databasePath);
  const staged = observeRestorationFile(join(publication.staging, "project.sqlite"));
  if (
    publication.version !== 2 ||
    target.links < 2n ||
    !sameRestorationFile(target.identity, publication.databaseIdentity) ||
    !sameRestorationFile(target.identity, staged.identity)
  ) {
    throw restorationOwnershipError(publication.databasePath);
  }
}

/**
 * Требует отсутствие SQLite companions. sealed-private допускает только SHM-индекс под удерживаемым
 * DELETE/EXCLUSIVE-барьером Storage; его принадлежность и очистку отдельно проверяет вызывающий.
 * Для отсутствующего публичного target применяется только строгий режим all.
 */
export function requireNoRestorationJournals(
  databasePath: string,
  mode: "all" | "sealed-private" = "all",
): void {
  const suffixes = mode === "sealed-private" ? ["-wal", "-journal"] : ["-wal", "-shm", "-journal"];
  for (const suffix of suffixes) {
    if (fileExists(`${databasePath}${suffix}`)) {
      throw new RelayError("RESTORE_DATABASE_OPEN", projectMessages.restoreDatabaseOpen, 4, {
        path: databasePath,
        journalPath: `${databasePath}${suffix}`,
      });
    }
  }
}

/**
 * После успешной привязки убирает лишь доказанные private links/пустой directory и общий intent.
 * Публичный datafile не удаляет. null означает завершение; иначе возвращается причина отказа:
 * вызывающий возвращает recovery-info, а не объявляет очистку успешной и не откатывает готовую БД.
 * Утрата владения или journals до уборки выбрасывают отказ, а не маскируются успешным resume с warning.
 */
export function cleanupResumedRestoration(
  publication: RestorationPublication,
  markerPath: string,
): RestorationCleanupFailure | null {
  requireRestorationOwnership(publication, markerPath);
  requireRestorationDatabaseLink(publication);
  requireNoRestorationJournals(join(publication.staging, "project.sqlite"));
  try {
    const entries = readdirSync(publication.staging);
    if (entries.some((name) => name !== "project.sqlite" && name !== RESTORATION_STAGING_MARKER)) {
      return {
        code: "RESTORE_CLEANUP_UNOWNED_FILES",
        message: restorationMessages.cleanupUnknownFiles,
      };
    }
    unlinkSync(join(publication.staging, "project.sqlite"));
    unlinkSync(join(publication.staging, RESTORATION_STAGING_MARKER));
    rmdirSync(publication.staging);
    unlinkSync(markerPath);
    return null;
  } catch (error) {
    return {
      code:
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "IO_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
