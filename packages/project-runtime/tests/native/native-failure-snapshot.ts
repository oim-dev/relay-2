import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeGitSyncSupervisor, readGitSyncControlEndpoint } from "@relay/project-runtime";
import { failureDiagnostic, type NativeCommands } from "./native-command";
import type { NativeConfiguration } from "./native-service.types";
import { readWindowsFailureSnapshot } from "./native-windows";

/**
 * Удерживает отказ отдельного чтения в снимке, чтобы отсутствие журнала не скрыло task result.
 */
async function observe(label: string, read: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    return { label, value: await read() };
  } catch (error) {
    return { label, readError: failureDiagnostic(error) };
  }
}

/**
 * До disable сохраняет bounded readonly-наблюдения своего manager и sanitized endpoint.
 * Не повторяет мутации, не запускает supervisor и не меняет состояние системных журналов.
 */
export async function captureNativeFailure(
  commands: NativeCommands,
  config: NativeConfiguration,
  binary: string,
  version: string,
  stage: string,
  error: unknown,
): Promise<void> {
  const observations = [
    observe("installed-configuration", () =>
      readFileSync(config.path, config.platform === "win32" ? "utf16le" : "utf8"),
    ),
    observe("control-endpoint", () => {
      const endpoint = readGitSyncControlEndpoint(join(config.home, "git-sync/supervisor.json"));
      if (!endpoint) {
        return null;
      }
      const { capability: _capability, ...publicEndpoint } = endpoint;
      return publicEndpoint;
    }),
    observe("health", () => probeGitSyncSupervisor(config.home, { version, timeoutMs: 2000 })),
  ];
  if (config.platform === "linux") {
    observations.push(
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
        commands.run(
          "systemctl",
          ["--user", "status", config.id, "--no-pager", "--full"],
          [0, 3, 4],
        ),
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
    );
  } else if (config.platform === "win32") {
    observations.push(
      observe("task-scheduler", () => readWindowsFailureSnapshot(commands, config, binary)),
    );
  } else {
    observations.push(
      observe("launchd", () =>
        commands.run("launchctl", ["print", `gui/${process.getuid?.()}/${config.id}`], [0, 113]),
      ),
    );
  }
  writeFileSync(
    join(commands.directory, `failure-${stage}.json`),
    JSON.stringify(
      {
        stage,
        capturedAt: new Date().toISOString(),
        error: failureDiagnostic(error),
        observations: await Promise.all(observations),
      },
      null,
      2,
    ),
  );
}
