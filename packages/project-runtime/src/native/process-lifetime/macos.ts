import { terminateCommandGroup } from "./posix-group";
import type { ProcessLifetime } from "./lifetime.types";
import type { CommandTree } from "../../process-guardian/tree.types";

/**
 * macOS управляет только наследуемой foreground-группой; setsid не удерживается.
 */
export const macosProcessLifetime: ProcessLifetime = {
  capability: "posix-group-foreground-only",
  guardianSpawn: { detached: true },
  commandSpawn: {},
  /**
   * Назначает группу якоря границей cleanup без обещания atomic fork-barrier.
   */
  ownTree(pid): CommandTree {
    return {
      /**
       * Завершает группу независимо от exit непосредственной команды.
       */
      async terminate(): Promise<void> {
        terminateCommandGroup(pid);
      },
      /**
       * Process group не удерживает native handles в guardian.
       */
      dispose(): void {},
    };
  },
  /**
   * Завершает собственную группу при потере guardian.
   */
  ownerLost(): void {
    terminateCommandGroup(process.pid);
  },
  /**
   * Передаёт graceful-сигнал собственной группе.
   */
  stopAnchor(input): void {
    process.kill(-process.pid, input.signal);
  },
};
