import { createWindowsJob } from "./windows-job";
import type { ProcessLifetime } from "./lifetime.types";

/**
 * Windows Job Object удерживает detached-потомков и закрывается после подтверждённого cleanup.
 */
export const windowsProcessLifetime: ProcessLifetime = {
  capability: "windows-job",
  guardianSpawn: { detached: true, windowsHide: true },
  commandSpawn: { windowsHide: true },
  ownTree: createWindowsJob,
  /**
   * Смерть guardian закрывает его единственный Job handle: KILL_ON_JOB_CLOSE выполняет ОС.
   */
  ownerLost(): void {},
  /**
   * Windows не доставляет POSIX-сигнал JS handler: lease закрывается EOF; без lease
   * kill адресует только ещё живую непосредственную команду через её process handle.
   */
  stopAnchor(input): void {
    if (input.stdinLease) {
      input.child?.stdin?.end();
    } else if (input.child && !input.commandEnded) {
      input.child.kill(input.signal);
    }
  },
};
