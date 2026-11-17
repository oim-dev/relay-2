import { dlopen, FFIType, ptr } from "bun:ffi";
import { combineProcessFailures } from "../../process-guardian/component-failures";
import { parentProcessMessages as messages } from "../../parent-process/observation.messages";
import type { ParentProcessProbe } from "../../parent-process/observation.types";

/* Только ожидание exit и чтение времени создания, без PROCESS_TERMINATE или права записи. */
const parentAccess = 0x0010_1000;
const queryAccess = 0x1000;
const waitObject = 0;
const waitTimeout = 258;
const errorInvalidParameter = 87;

/**
 * Удерживает неунаследованный handle исходного Windows-родителя до dispose.
 * Проверка времени создания отвергает уже переиспользованный PID: новый процесс не мог
 * создать текущего. Дальнейшие проверки используют только handle, никогда повторный OpenProcess.
 * Исчезнувший родитель даёт false; ACL/Win32-ошибка отклоняется явно. Никакие процессы не завершаются.
 */
export function captureWindowsParent(parentPid: number): ParentProcessProbe {
  const api = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    GetProcessTimes: {
      args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  let parent: number | bigint = 0;
  let current: number | bigint = 0;
  let matches = false;
  let disposed = false;
  /**
   * Сохраняет имя syscall и GetLastError до следующих Win32-вызовов.
   */
  function nativeFailure(syscall: string, code = api.symbols.GetLastError()): Error {
    return Object.assign(new Error(messages.windowsFailure(syscall, code)), {
      syscall,
      win32Code: code,
    });
  }
  /**
   * Читает FILETIME создания по удержанному handle без зависимости от диагностического PID.
   */
  function creationTime(handle: number | bigint): bigint {
    const times = Buffer.alloc(32);
    if (
      !api.symbols.GetProcessTimes(
        handle,
        ptr(times.subarray(0, 8)),
        ptr(times.subarray(8, 16)),
        ptr(times.subarray(16, 24)),
        ptr(times.subarray(24, 32)),
      )
    ) {
      throw nativeFailure("GetProcessTimes");
    }
    return times.readBigUInt64LE(0);
  }
  /**
   * Закрывает оба собственных handle и библиотеку, сохраняя все ошибки освобождения.
   */
  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    const failures: Error[] = [];
    for (const handle of [current, parent]) {
      if (handle && !api.symbols.CloseHandle(handle)) {
        failures.push(nativeFailure("CloseHandle"));
      }
    }
    api.close();
    if (failures.length > 0) {
      throw new AggregateError(failures, messages.failed);
    }
  }
  try {
    if (process.ppid === parentPid) {
      parent = api.symbols.OpenProcess(parentAccess, 0, parentPid);
      if (!parent) {
        const code = api.symbols.GetLastError();
        if (code !== errorInvalidParameter) {
          throw nativeFailure("OpenProcess(parent)", code);
        }
      } else {
        current = api.symbols.OpenProcess(queryAccess, 0, process.pid);
        if (!current) {
          throw nativeFailure("OpenProcess(current)");
        }
        matches = creationTime(parent) <= creationTime(current);
        if (!api.symbols.CloseHandle(current)) {
          throw nativeFailure("CloseHandle(current)");
        }
        current = 0;
      }
    }
  } catch (cause) {
    try {
      dispose();
    } catch (cleanup) {
      throw combineProcessFailures(cause, cleanup);
    }
    throw cause;
  }
  return {
    /**
     * Неблокирующе проверяет сигнализацию того же process object; PID reuse не влияет на handle.
     */
    isAlive(): boolean {
      if (!matches) {
        return false;
      }
      const result = api.symbols.WaitForSingleObject(parent, 0);
      if (result === waitObject) {
        return false;
      }
      if (result === waitTimeout) {
        return true;
      }
      throw nativeFailure("WaitForSingleObject");
    },
    dispose,
  };
}
