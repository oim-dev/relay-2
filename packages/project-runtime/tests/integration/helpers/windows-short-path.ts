import { dlopen, FFIType, ptr } from "bun:ffi";
import { basename, toNamespacedPath } from "node:path";

/**
 * Получает настоящее короткое имя файла через Win32 без изменения политики тома.
 * null означает, что последний компонент не имеет отдельного алиаса 8.3.
 * Вызывающий владеет существующим файлом; системный отказ сохраняет код Win32 в диагностике.
 */
export function windowsShortFilePath(path: string): string | null {
  const api = dlopen("kernel32.dll", {
    GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  try {
    const name = Buffer.from(`${toNamespacedPath(path)}\0`, "utf16le");
    const capacity = api.symbols.GetShortPathNameW(ptr(name), null, 0);
    if (capacity === 0) {
      throw new Error(`GetShortPathNameW: Win32 ${api.symbols.GetLastError()}`);
    }
    const buffer = Buffer.alloc(capacity * 2);
    const length = api.symbols.GetShortPathNameW(ptr(name), ptr(buffer), capacity);
    if (length === 0 || length >= capacity) {
      throw new Error(`GetShortPathNameW: Win32 ${api.symbols.GetLastError()}, длина ${length}`);
    }
    const short = buffer.subarray(0, length * 2).toString("utf16le");
    return basename(short).toLowerCase() === basename(path).toLowerCase() ? null : short;
  } finally {
    api.close();
  }
}
