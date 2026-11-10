import { currentNativePlatform } from "@relay/project-runtime";
import { killLinuxFixtureGroup } from "./linux/process-group";
import { killMacosFixtureGroup } from "./macos/process-group";

/**
 * Выбирает POSIX-уборку только для своей detached-группы после assertions сценария.
 * Windows не поддерживает этот сценарий; случайный вызов не сигнализирует чужому PID.
 */
export function killFixtureProcessGroup(pid: number): void {
  switch (currentNativePlatform()) {
    case "linux":
      return killLinuxFixtureGroup(pid);
    case "darwin":
      return killMacosFixtureGroup(pid);
    case "win32":
      throw new Error("Windows не поддерживает POSIX-группу процессной fixture");
  }
}
