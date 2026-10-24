import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { fileExists } from "../configuration/files";
import { projectMessages } from "./project.messages";
import { restorationMessages } from "./restoration.messages";
import type {
  CurrentRestorationPublication,
  RestorationPublication,
} from "./restoration-publication.types";
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
 * Проверяет точную идентичность v3 marker, его private hardlink (пока он есть) и исходный datafile.
 * После rename datafile разрешён только под public именем; до rename — только в staging.
 * После public publication отсутствие private marker/directory допускается как прерванная cleanup:
 * сохранённая идентичность самого marker отличает её от копии и позволяет завершить уборку.
 * Прежние intents v1/v2 отвергаются без чтения SQLite и уборки их aliases.
 */
export function requireRestorationOwnership(
  publication: RestorationPublication,
  markerPath: string,
): asserts publication is CurrentRestorationPublication {
  if (publication.version !== 3) {
    throw new RelayError("RESTORE_RECOVERY_REQUIRED", restorationMessages.legacyPublication, 4, {
      path: markerPath,
      reason: "legacy-publication",
      version: publication.version,
    });
  }
  try {
    const directoryExists = fileExists(publication.staging);
    if (directoryExists && !lstatSync(publication.staging).isDirectory()) {
      throw restorationOwnershipError(publication.staging);
    }
    const marker = observeRestorationFile(markerPath);
    if (!sameRestorationFile(marker.identity, publication.markerIdentity)) {
      throw restorationOwnershipError(markerPath);
    }
    const privateMarkerPath = join(publication.staging, RESTORATION_STAGING_MARKER);
    const privateMarkerExists = fileExists(privateMarkerPath);
    if (
      privateMarkerExists &&
      !sameRestorationFile(marker.identity, observeRestorationFile(privateMarkerPath).identity)
    ) {
      throw restorationOwnershipError(privateMarkerPath);
    }
    const stagedPath = join(publication.staging, "project.sqlite");
    if (fileExists(publication.databasePath)) {
      requirePublishedRestorationDatabase(publication);
    } else {
      if (!directoryExists || !privateMarkerExists) {
        throw restorationOwnershipError(publication.staging);
      }
      const staged = observeRestorationFile(stagedPath);
      if (!sameRestorationFile(staged.identity, publication.databaseIdentity)) {
        throw restorationOwnershipError(stagedPath);
      }
    }
  } catch (cause) {
    if (cause instanceof RelayError) {
      throw cause;
    }
    throw restorationOwnershipError(publication.staging, cause);
  }
}

/**
 * Принимает только исходный опубликованный datafile; совпавший projectId чужого файла не даёт ownership.
 * Rename не может оставить staging alias. Hardlink допустим только на Windows, где ОС защищает live handles.
 */
export function requirePublishedRestorationDatabase(
  publication: CurrentRestorationPublication,
): void {
  const target = observeRestorationFile(publication.databasePath);
  const stagedPath = join(publication.staging, "project.sqlite");
  if (!sameRestorationFile(target.identity, publication.databaseIdentity)) {
    throw restorationOwnershipError(publication.databasePath);
  }
  if (publication.transfer === "rename") {
    if (fileExists(stagedPath)) {
      throw restorationOwnershipError(stagedPath);
    }
    return;
  }
  if (process.platform !== "win32") {
    throw restorationOwnershipError(publication.databasePath);
  }
  if (fileExists(stagedPath)) {
    const staged = observeRestorationFile(stagedPath);
    if (target.links < 2n || !sameRestorationFile(target.identity, staged.identity)) {
      throw restorationOwnershipError(publication.databasePath);
    }
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
 * После успешной привязки убирает доказанные private metadata/пустой directory и общий intent.
 * Unix datafile уже перемещён и не затрагивается. На Windows sharing-отказ оставляет alias для retry.
 * Публичный datafile не удаляет. null означает завершение; иначе возвращается причина отказа:
 * вызывающий возвращает recovery-info, а не объявляет очистку успешной и не откатывает готовую БД.
 * Утрата владения или journals до уборки выбрасывают отказ, а не маскируются успешным resume с warning.
 */
export function cleanupResumedRestoration(
  publication: RestorationPublication,
  markerPath: string,
): RestorationCleanupFailure | null {
  requireRestorationOwnership(publication, markerPath);
  requirePublishedRestorationDatabase(publication);
  requireNoRestorationJournals(join(publication.staging, "project.sqlite"));
  try {
    const directoryExists = fileExists(publication.staging);
    const entries = directoryExists ? readdirSync(publication.staging) : [];
    const expected =
      publication.transfer === "rename"
        ? [RESTORATION_STAGING_MARKER]
        : ["project.sqlite", RESTORATION_STAGING_MARKER];
    if (entries.some((name) => !expected.includes(name))) {
      return {
        code: "RESTORE_CLEANUP_UNOWNED_FILES",
        message: restorationMessages.cleanupUnknownFiles,
      };
    }
    if (
      publication.transfer === "hardlink" &&
      fileExists(join(publication.staging, "project.sqlite"))
    ) {
      unlinkSync(join(publication.staging, "project.sqlite"));
    }
    const privateMarker = join(publication.staging, RESTORATION_STAGING_MARKER);
    if (fileExists(privateMarker)) {
      unlinkSync(privateMarker);
    }
    if (directoryExists) {
      rmdirSync(publication.staging);
    }
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
