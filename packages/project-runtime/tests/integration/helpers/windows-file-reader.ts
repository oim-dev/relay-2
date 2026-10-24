import { dlopen, FFIType, ptr } from "bun:ffi";
import { expect } from "bun:test";
import { toNamespacedPath } from "node:path";

/**
 * Удерживает настоящий Windows read-handle без FILE_SHARE_DELETE на время синхронного сценария.
 * Это внешний несотрудничающий читатель, в отличие от обычного Bun openSync с share-delete.
 * Путь принадлежит fixture; helper ничего не пишет, проверяет закрытие handle и освобождает DLL.
 */
export function withWindowsDeleteDeniedReader<T>(path: string, operation: () => T): T {
  const api = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.u64,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  try {
    const name = Buffer.from(`${toNamespacedPath(path)}\0`, "utf16le");
    // GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL.
    const handle = api.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, 0x80, null);
    if (BigInt(handle) === 0xffffffffffffffffn) {
      throw new Error(`CreateFileW чужого читателя: Win32 ${api.symbols.GetLastError()}`);
    }
    try {
      return operation();
    } finally {
      expect(api.symbols.CloseHandle(handle)).toBe(1);
    }
  } finally {
    api.close();
  }
}
