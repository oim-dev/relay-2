import { readFileSync } from "node:fs";

/**
 * Читает состояние конкретного PID без сигналов: zombie уже не исполняется, reap остаётся ядру.
 * Только ENOENT/ESRCH означают исчезновение процесса; ошибки доступа и формата видимы тесту.
 */
export function linuxProcessRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const state = stat.slice(end + 2).split(" ")[0];
    if (end < 0 || !state || !/^[A-Z]$/u.test(state)) {
      throw new Error("Некорректный Linux stat процессной fixture");
    }
    return state !== "Z";
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ESRCH"].includes(String(error.code))
    ) {
      return false;
    }
    throw error;
  }
}
