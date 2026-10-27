import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { publicationMoveFailure } from "./errors";
import type { DatabasePublication } from "./publication.types";

/**
 * macOS-публикация единственного имени без сохранения private SQLite-alias.
 */
export const macosDatabasePublication: DatabasePublication = {
  transfer: "rename",
  /**
   * Применяет renamex_np(RENAME_EXCL); конкурентный target сохраняется с EEXIST.
   */
  publish(source, destination): void {
    const from = Buffer.from(`${source}\0`);
    const to = Buffer.from(`${destination}\0`);
    const api = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    try {
      if (api.symbols.renamex_np(ptr(from), ptr(to), 0x00000004) !== 0) {
        const address = api.symbols.__error();
        throw publicationMoveFailure(
          "renamex_np",
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
