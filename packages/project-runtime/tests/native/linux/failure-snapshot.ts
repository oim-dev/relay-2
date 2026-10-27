import type { NativeCommands } from "../native-command";
import type { NativeConfiguration } from "../native-service.types";
import { observe } from "../native-observation";

/**
 * Снимает bounded readonly-диагностику своего user-systemd unit; журнал не перенастраивается.
 */
export function linuxFailureObservations(
  commands: NativeCommands,
  config: NativeConfiguration,
): readonly Promise<unknown>[] {
  return [
    observe("systemd-properties", () =>
      commands.run(
        "systemctl",
        [
          "--user",
          "show",
          config.id,
          "--no-pager",
          "--property=LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainCode,ExecMainStatus,MainPID,ExecMainPID,NRestarts,ExecStart,FragmentPath,InvocationID,ExecMainStartTimestamp,ExecMainExitTimestamp,ConditionResult,AssertResult,StatusText",
        ],
        [0, 4],
      ),
    ),
    observe("systemd-status", () =>
      commands.run("systemctl", ["--user", "status", config.id, "--no-pager", "--full"], [0, 3, 4]),
    ),
    observe("systemd-journal", () =>
      commands.run("journalctl", [
        "--user",
        "--unit",
        config.id,
        "--no-pager",
        "--output=json",
        "--lines=100",
      ]),
    ),
  ];
}
