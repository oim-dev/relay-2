import { createWindowsJob } from "./windows-job";
import { createLinuxTree } from "./linux-tree";
import { terminateCommandGroup } from "./posix-group";
import type { CommandTree } from "./tree.types";

/**
 * Привязывает контейнер к живому якорю до отправки команды.
 * macOS управляет наследуемой группой; Linux subreaper и Windows job удерживают и setsid-потомков.
 */
export function ownCommandTree(pid: number): CommandTree {
  if (process.platform === "win32") {
    return createWindowsJob(pid);
  }
  if (process.platform === "linux") {
    return createLinuxTree(pid);
  }
  return {
    /**
     * Убивает собственную группу, даже если основная команда вышла, а pipe удерживает потомок.
     */
    async terminate(): Promise<void> {
      terminateCommandGroup(pid);
    },
    /**
     * POSIX-группа не использует отдельных файловых дескрипторов владельца.
     */
    dispose(): void {},
  };
}
