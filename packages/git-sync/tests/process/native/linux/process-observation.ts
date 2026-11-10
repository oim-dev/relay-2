import { readFileSync } from "node:fs";

/**
 * Отличает исполняющийся Linux-процесс от zombie чтением procfs без сигналов завершения.
 * Ошибки доступа/формата не означают отсутствие; только ENOENT/ESRCH допускают исчезнувший PID.
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
