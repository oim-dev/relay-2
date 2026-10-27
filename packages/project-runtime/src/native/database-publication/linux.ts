import { dlopen, FFIType, ptr, read, type Library } from "bun:ffi";
import { publicationMoveFailure } from "./errors";
import type { DatabasePublication } from "./publication.types";

const symbols = {
  renameat2: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  __errno_location: { args: [], returns: FFIType.ptr },
} as const;

/**
 * Загружает Linux libc для поддерживаемых ABI; отсутствующий syscall не получает unsafe fallback.
 */
function linuxApi(): Library<typeof symbols> {
  try {
    return dlopen("libc.so.6", symbols);
  } catch {
    const musl = process.arch === "arm64" ? "libc.musl-aarch64.so.1" : "libc.musl-x86_64.so.1";
    return dlopen(musl, symbols);
  }
}

/**
 * Linux-публикация единственного имени: после успеха private SQLite-alias отсутствует.
 */
export const linuxDatabasePublication: DatabasePublication = {
  transfer: "rename",
  /**
   * Применяет renameat2(RENAME_NOREPLACE) под внешним SQLite-lock.
   */
  publish(source, destination): void {
    const from = Buffer.from(`${source}\0`);
    const to = Buffer.from(`${destination}\0`);
    const api = linuxApi();
    try {
      if (api.symbols.renameat2(-100, ptr(from), -100, ptr(to), 1) !== 0) {
        const address = api.symbols.__errno_location();
        throw publicationMoveFailure(
          "renameat2",
          address ? read.i32(address) : 0,
          source,
          destination,
        );
      }
    } finally {
      api.close();
    }
  },
};
