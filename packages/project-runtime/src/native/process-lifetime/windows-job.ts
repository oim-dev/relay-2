import { dlopen, FFIType, ptr } from "bun:ffi";
import { GuardedCommandError } from "../../process-guardian/errors";
import { treeCleanupMs } from "../../process-guardian/protocol";
import type { CommandTree } from "../../process-guardian/tree.types";

/* JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: закрытие последнего handle завершает всех участников. */
const killOnClose = 0x2000;
/* PROCESS_SET_QUOTA | PROCESS_TERMINATE — права, необходимые AssignProcessToJobObject. */
const assignmentAccess = 0x0101;

/**
 * Создаёт приватный Windows Job Object до передачи команды якорю.
 * Потомки наследуют job даже при DETACHED_PROCESS и после выхода основной команды.
 * Breakaway не разрешён; смерть guardian закрывает его единственный неунаследованный handle.
 */
export function createWindowsJob(pid: number): CommandTree {
  const api = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    SetInformationJobObject: {
      args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    QueryInformationJobObject: {
      args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const job = api.symbols.CreateJobObjectW(null, null);
  let disposed = false;
  try {
    if (!job) {
      throw new GuardedCommandError("spawn", { cause: api.symbols.GetLastError() });
    }
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION имеет размер 144 на поддерживаемых Bun Win64 ABI.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(killOnClose, 16);
    if (!api.symbols.SetInformationJobObject(job, 9, ptr(limits), limits.length)) {
      throw new GuardedCommandError("spawn", { cause: api.symbols.GetLastError() });
    }
    const processHandle = api.symbols.OpenProcess(assignmentAccess, 0, pid);
    if (!processHandle) {
      throw new GuardedCommandError("spawn", { cause: api.symbols.GetLastError() });
    }
    try {
      if (!api.symbols.AssignProcessToJobObject(job, processHandle)) {
        throw new GuardedCommandError("spawn", { cause: api.symbols.GetLastError() });
      }
    } finally {
      api.symbols.CloseHandle(processHandle);
    }
  } catch (cause) {
    if (job) {
      api.symbols.CloseHandle(job);
    }
    api.close();
    throw cause;
  }
  return {
    /**
     * Завершает весь job, не затрагивая guardian и процессы за пределами контейнера.
     */
    async terminate(): Promise<void> {
      if (disposed || !api.symbols.TerminateJobObject(job, 1)) {
        throw new GuardedCommandError("cleanup", { cause: api.symbols.GetLastError() });
      }
      const accounting = Buffer.alloc(48);
      const deadline = performance.now() + treeCleanupMs;
      while (true) {
        if (
          !api.symbols.QueryInformationJobObject(job, 1, ptr(accounting), accounting.length, null)
        ) {
          throw new GuardedCommandError("cleanup", { cause: api.symbols.GetLastError() });
        }
        if (accounting.readUInt32LE(40) === 0) {
          return;
        }
        if (performance.now() >= deadline) {
          throw new GuardedCommandError("cleanup");
        }
        await Bun.sleep(5);
      }
    },
    /**
     * Освобождает единственный handle; KILL_ON_JOB_CLOSE остаётся резервной очисткой.
     */
    dispose(): void {
      if (!disposed) {
        disposed = true;
        const closed = api.symbols.CloseHandle(job);
        const error = closed ? undefined : api.symbols.GetLastError();
        api.close();
        if (!closed) {
          throw new GuardedCommandError("cleanup", { cause: error });
        }
      }
    },
  };
}
