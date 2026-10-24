import { dlopen, FFIType, ptr, read, type Library } from "bun:ffi";
import { linkSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { restorationMessages } from "./restoration.messages";
import type {
  CurrentRestorationPublication,
  RestorationTransfer,
} from "./restoration-publication.types";

const linuxSymbols = {
  renameat2: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  __errno_location: { args: [], returns: FFIType.ptr },
} as const;

/**
 * Выбирает поддержанный протокол: Unix не сохраняет удаляемый SQLite-alias, Windows удерживает
 * старый hardlink до успешного unlink, защищённого нативными правилами sharing SQLite-handle.
 */
export function restorationTransfer(): RestorationTransfer {
  return process.platform === "win32" ? "hardlink" : "rename";
}

/**
 * Загружает системную Linux libc с renameat2; отсутствие syscall/FS-флага не заменяется unsafe fallback.
 */
function linuxApi(): Library<typeof linuxSymbols> {
  try {
    return dlopen("libc.so.6", linuxSymbols);
  } catch {
    const musl = process.arch === "arm64" ? "libc.musl-aarch64.so.1" : "libc.musl-x86_64.so.1";
    return dlopen(musl, linuxSymbols);
  }
}

/**
 * Сохраняет errno и обе стороны отказавшего атомарного переноса; EEXIST не разрешает замену target.
 */
function moveFailure(syscall: string, errno: number, source: string, destination: string): Error {
  return Object.assign(new Error(restorationMessages.moveFailed(syscall, errno)), {
    code: errno === 17 ? "EEXIST" : "IO_ERROR",
    errno,
    syscall,
    path: source,
    dest: destination,
  });
}

/**
 * Переносит единственное private-имя в ещё не существующее public-имя одним нативным syscall.
 * Оба пути принадлежат одной ФС. Не использует unlink target, обычный заменяющий rename или копирование.
 * SQL-barrier остаётся у вызывающего; после успеха старое имя отсутствует, inode не меняется.
 */
function moveExclusive(source: string, destination: string): void {
  const from = Buffer.from(`${source}\0`);
  const to = Buffer.from(`${destination}\0`);
  if (process.platform === "darwin") {
    const api = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    try {
      // RENAME_EXCL: существующий target вызывает EEXIST, включая конкурентную публикацию.
      if (api.symbols.renamex_np(ptr(from), ptr(to), 0x00000004) !== 0) {
        const address = api.symbols.__error();
        throw moveFailure("renamex_np", address ? read.i32(address) : 0, source, destination);
      }
    } finally {
      api.close();
    }
    return;
  }
  if (process.platform === "linux") {
    const api = linuxApi();
    try {
      // AT_FDCWD и RENAME_NOREPLACE; пути абсолютны, cwd процесса не участвует в выборе.
      if (api.symbols.renameat2(-100, ptr(from), -100, ptr(to), 1) !== 0) {
        const address = api.symbols.__errno_location();
        throw moveFailure("renameat2", address ? read.i32(address) : 0, source, destination);
      }
    } finally {
      api.close();
    }
    return;
  }
  throw new RelayError("RESTORE_RECOVERY_REQUIRED", restorationMessages.transferUnavailable, 4, {
    source,
    destination,
  });
}

/**
 * Выполняет способ публикации, сохранённый в проверенном v3 intent. Вызывающий удерживает SQLite-lock
 * и уже проверил владение/отсутствие journals. Неизвестный платформе способ отклоняется с сохранением файлов.
 */
export function transferRestorationDatabase(publication: CurrentRestorationPublication): void {
  const source = join(publication.staging, "project.sqlite");
  if (publication.transfer === "hardlink") {
    if (process.platform !== "win32") {
      throw new RelayError(
        "RESTORE_RECOVERY_REQUIRED",
        restorationMessages.transferUnavailable,
        4,
        { path: source },
      );
    }
    linkSync(source, publication.databasePath);
    return;
  }
  moveExclusive(source, publication.databasePath);
}
