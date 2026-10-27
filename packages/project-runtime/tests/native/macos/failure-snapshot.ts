import type { NativeCommands } from "../native-command";
import type { NativeConfiguration } from "../native-service.types";
import { observe } from "../native-observation";

/**
 * Читает состояние своего LaunchAgent без kickstart и изменения сессии.
 */
export function macosFailureObservations(
  commands: NativeCommands,
  config: NativeConfiguration,
): readonly Promise<unknown>[] {
  return [
    observe("launchd", () =>
      commands.run("launchctl", ["print", `gui/${process.getuid?.()}/${config.id}`], [0, 113]),
    ),
  ];
}
