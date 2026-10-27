import { currentNativePlatform } from "@relay/project-runtime";
import { terminateLinuxGroup } from "./linux/process-tree";
import { terminateMacosGroup } from "./macos/process-tree";
import { terminateWindowsTree } from "./windows/process-tree";
import type { FixtureProcessTree } from "./process-tree.types";

/**
 * Выбирает согласованные spawn/cleanup для собственных процессов fixture без запуска команд.
 */
export function fixtureProcessTree(): FixtureProcessTree {
  switch (currentNativePlatform()) {
    case "linux":
      return { detached: true, terminate: terminateLinuxGroup };
    case "darwin":
      return { detached: true, terminate: terminateMacosGroup };
    case "win32":
      return { detached: false, terminate: terminateWindowsTree };
  }
}
