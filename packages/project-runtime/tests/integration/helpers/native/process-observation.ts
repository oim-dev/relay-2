import { currentNativePlatform } from "@relay/project-runtime";
import { linuxProcessRunning } from "./linux/process-observation";

/**
 * Наблюдает завершение независимо от production guardian и до аварийной уборки fixture.
 * Linux отличает zombie через procfs; переносимый signal-0 API Bun на остальных ОС
 * подтверждает существование PID. Ошибки доступа не считаются завершением процесса.
 */
export function running(pid: number): boolean {
  if (currentNativePlatform() === "linux") {
    return linuxProcessRunning(pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
