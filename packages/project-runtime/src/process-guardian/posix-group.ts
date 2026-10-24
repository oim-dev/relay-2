import { GuardedCommandError } from "./errors";

/**
 * Посылает SIGKILL группе собственного якоря, включая переживших основную команду участников.
 * Принимает только PID созданного вызывающим якоря, а не произвольный пользовательский PID.
 * fork, exec и потеря родителя сохраняют PGID; выход через setsid/setpgid этим механизмом
 * не запрещён. Вызов не является атомарным запретом новых fork и не заменяет job-контейнер.
 */
export function terminateCommandGroup(anchorPid: number): void {
  if (!Number.isSafeInteger(anchorPid) || anchorPid <= 1) {
    throw new GuardedCommandError("cleanup");
  }
  try {
    process.kill(-anchorPid, "SIGKILL");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
      throw new GuardedCommandError("cleanup", { cause });
    }
  }
}
