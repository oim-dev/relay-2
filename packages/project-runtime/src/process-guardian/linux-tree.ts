import { dlopen, FFIType, type Library } from "bun:ffi";
import { readFileSync, readdirSync } from "node:fs";
import { GuardedCommandError } from "./errors";
import { treeCleanupMs } from "./protocol";
import { terminateCommandGroup } from "./posix-group";
import type { CommandTree } from "./tree.types";

/* prctl использует variadic unsigned long; waitpid нужен лишь для усыновлённых детей. */
const linuxSymbols = {
  prctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.i32,
  },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const;

/**
 * Загружает системную libc для поддерживаемых Bun Linux ABI: glibc либо musl x64/arm64.
 */
function openLinuxApi(): Library<typeof linuxSymbols> {
  const musl = process.arch === "arm64" ? "libc.musl-aarch64.so.1" : "libc.musl-x86_64.so.1";
  try {
    return dlopen("libc.so.6", linuxSymbols);
  } catch {
    return dlopen(musl, linuxSymbols);
  }
}

/**
 * Procfs может вернуть ENOENT при открытии и ESRCH при чтении уже исчезнувшей задачи.
 * Это нормальная гонка после SIGKILL; остальные ошибки запрещают подтверждать cleanup.
 */
function disappeared(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

/**
 * Читает прямых детей всех native threads собственного процесса из procfs.
 * После включения subreaper сюда усыновляются также потомки с setsid при выходе их родителя.
 */
function ownChildren(): number[] {
  const pids = new Set<number>();
  for (const task of readdirSync("/proc/self/task")) {
    let children: string;
    try {
      children = readFileSync(`/proc/self/task/${task}/children`, "utf8");
    } catch (error) {
      if (disappeared(error)) {
        continue;
      }
      throw error;
    }
    for (const item of children.trim().split(/\s+/)) {
      const pid = Number(item);
      if (Number.isSafeInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
  }
  return [...pids];
}

/**
 * Проверяет текущее родство непосредственно перед сигналом, исключая чужой переиспользованный PID.
 * null означает исчезнувший или уже не принадлежащий guardian процесс.
 */
function ownedState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const [state, parent] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(parent) === process.pid && state !== undefined ? state : null;
  } catch (error) {
    if (disappeared(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Дополняет POSIX-группу Linux subreaper: detached-потомки не теряются после выхода основной команды.
 * Включается только в приватном однокомандном guardian, до разрешающего frame якорю.
 */
export function createLinuxTree(anchorPid: number): CommandTree {
  const api = openLinuxApi();
  if (api.symbols.prctl(36, 1n, 0n, 0n, 0n) !== 0) {
    api.close();
    throw new GuardedCommandError("spawn");
  }
  try {
    ownChildren();
  } catch (cause) {
    api.close();
    throw new GuardedCommandError("spawn", { cause });
  }
  let disposed = false;
  return {
    /**
     * Сначала убивает группу, затем усыновлённых детей до исчезновения всего дерева.
     * Повторное чтение нужно для новых усыновлений после SIGKILL промежуточного родителя.
     */
    async terminate(): Promise<void> {
      const deadline = performance.now() + treeCleanupMs;
      terminateCommandGroup(anchorPid);
      while (true) {
        let active = false;
        for (const pid of ownChildren()) {
          const state = ownedState(pid);
          if (state === "Z" || state === "X") {
            if (pid !== anchorPid) {
              // За waitpid якоря отвечает Bun ChildProcess; усыновлённых детей Bun не регистрировал.
              api.symbols.waitpid(pid, null, 1);
            }
          } else if (state !== null) {
            active = true;
            try {
              process.kill(pid, "SIGKILL");
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
                throw error;
              }
            }
          }
        }
        if (!active && ownChildren().every((pid) => pid === anchorPid)) {
          return;
        }
        if (performance.now() >= deadline) {
          throw new GuardedCommandError("cleanup");
        }
        await Bun.sleep(5);
      }
    },
    /**
     * Освобождает только native bindings; роль guardian после ответа завершает процесс.
     */
    dispose(): void {
      if (!disposed) {
        disposed = true;
        api.close();
      }
    },
  };
}
