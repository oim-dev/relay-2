import { currentNativePlatform } from "@relay/project-runtime";
import { linuxProcessRunning } from "./linux/process-observation";

/**
 * Наблюдает живость PID независимо от проверяемой уборки guardian и до finally fixture.
 * На Linux zombie не исполняется; на macOS/Windows используется переносимый signal-0 API Bun.
 * Ошибки доступа не подменяются успешным исчезновением процесса.
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
