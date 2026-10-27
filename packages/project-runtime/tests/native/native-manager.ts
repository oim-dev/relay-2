import type { NativeCommands } from "./native-command";
import type { NativeConfiguration, NativeManager, NativeSession } from "./native-service.types";
import { LinuxNativeManager } from "./linux/manager";
import { MacosNativeManager } from "./macos/manager";
import { WindowsNativeManager } from "./windows/manager";

/**
 * Выбирает независимый наблюдатель настоящего manager без регистрации службы и файловых записей.
 */
export function createNativeManager(
  commands: NativeCommands,
  config: NativeConfiguration,
  binary: string,
  session: NativeSession,
): NativeManager {
  switch (config.platform) {
    case "linux":
      return new LinuxNativeManager(commands, config, binary);
    case "darwin":
      return new MacosNativeManager(commands, config, binary, session);
    case "win32":
      return new WindowsNativeManager(commands, config, binary);
  }
}
