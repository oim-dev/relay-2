import { createLinuxTree } from "./linux-tree";
import { terminateCommandGroup } from "./posix-group";
import type { ProcessLifetime } from "./lifetime.types";

/**
 * Linux удерживает группу и усыновлённых subreaper потомков, включая setsid.
 */
export const linuxProcessLifetime: ProcessLifetime = {
  capability: "linux-subreaper",
  guardianSpawn: { detached: true },
  commandSpawn: {},
  ownTree: createLinuxTree,
  /**
   * Убирает собственную POSIX-группу при потере guardian.
   */
  ownerLost(): void {
    terminateCommandGroup(process.pid);
  },
  /**
   * Посылает сигнал группе живого якоря, включая переживших непосредственную команду детей.
   */
  stopAnchor(input): void {
    process.kill(-process.pid, input.signal);
  },
};
