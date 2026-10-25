import { RelayError } from "@relay/contracts";
import { runNativeProcess } from "../git-sync/process";
import type { ProcessResult } from "../git-sync/process.types";
import { serviceFiles } from "../git-sync/service-files";
import type { ServiceConfiguration } from "../git-sync/service.types";
import { currentWindowsUser, windowsService, windowsState } from "../git-sync/service-windows";
import { checkServerCancellation } from "./probe";
import { probeServerLease } from "./registry";
import { createServerServiceConfiguration } from "./service-configuration";
import { serverMessages as messages } from "./server.messages";
import type { ServerEnvironment, ServerLaunch } from "./server.types";

/**
 * Адаптирует диагностику переиспользуемого native manager к серверной границе, сохраняя исходную причину.
 */
function serverServiceFailure(cause: unknown): never {
  if (!(cause instanceof RelayError) || !cause.code.startsWith("GIT_SYNC_")) {
    throw cause;
  }
  const code = cause.code.replace("GIT_SYNC_", "SERVER_");
  const message = code === "SERVER_SERVICE_OWNERSHIP" ? messages.ownership : messages.managerFailed;
  const error = new RelayError(code, message, cause.exitCode, cause.details);
  error.cause = cause;
  throw error;
}

/**
 * Выполняет native manager под общим guardian; потомок сервера создаётся самим manager, вне CLI lease.
 */
export async function runServerNative(
  environment: ServerEnvironment,
  executable: string,
  args: readonly string[],
  allowed: readonly number[] = [0],
): Promise<ProcessResult> {
  checkServerCancellation(environment);
  const result = await (environment.runner ?? runNativeProcess)({
    executable,
    args,
    cwd: environment.cwd,
    env: environment.env,
    timeoutMs: environment.timeoutMs ?? 30_000,
    ...(environment.signal ? { signal: environment.signal } : {}),
  }).catch(serverServiceFailure);
  if (!allowed.includes(result.exitCode)) {
    throw new RelayError("SERVER_SERVICE_FAILED", messages.managerFailed, 4, {
      executable,
      args,
      nativeExitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
}

/**
 * Изменяет только принадлежащий этому UUID user-systemd unit, сохраняя файл при отказе stop.
 */
async function linuxService(
  action: "enable" | "disable",
  config: ServiceConfiguration,
  environment: ServerEnvironment,
  installed: boolean,
): Promise<void> {
  const files = environment.serviceFiles ?? serviceFiles;
  const current = await runServerNative(
    environment,
    "systemctl",
    ["--user", "show", config.id, "--property=LoadState", "--no-pager"],
    [0, 4],
  );
  if (!installed && current.stdout.trim() !== "LoadState=not-found") {
    throw new RelayError("SERVER_SERVICE_OWNERSHIP", messages.ownership, 4, { id: config.id });
  }
  if (action === "disable") {
    if (installed) {
      await runServerNative(environment, "systemctl", ["--user", "disable", "--now", config.id]);
      files.remove(config.path);
      await runServerNative(environment, "systemctl", ["--user", "daemon-reload"]);
    }
    return;
  }
  files.write(config.path, config.content, config.platform);
  await runServerNative(environment, "systemctl", ["--user", "daemon-reload"]);
  await runServerNative(environment, "systemctl", ["--user", "enable", "--now", config.id]);
  if (installed) {
    await runServerNative(environment, "systemctl", ["--user", "restart", config.id]);
  }
}

/**
 * Управляет только LaunchAgent текущей GUI-сессии, проверяя label перед записью и bootout.
 */
async function macService(
  action: "enable" | "disable",
  config: ServiceConfiguration,
  environment: ServerEnvironment,
  installed: boolean,
): Promise<void> {
  const uid = environment.userId ?? process.getuid?.();
  if (uid === undefined) {
    throw new RelayError("SERVER_SERVICE_IDENTITY", messages.invalidInput, 2);
  }
  const files = environment.serviceFiles ?? serviceFiles;
  const domain = `gui/${uid}`;
  const target = `${domain}/${config.id}`;
  await runServerNative(environment, "launchctl", ["print", domain]);
  const current = await runServerNative(environment, "launchctl", ["print", target], [0, 113]);
  if (!installed && current.exitCode === 0) {
    throw new RelayError("SERVER_SERVICE_OWNERSHIP", messages.ownership, 4, { id: config.id });
  }
  if (current.exitCode === 0) {
    await runServerNative(environment, "launchctl", ["bootout", target]);
  }
  if (action === "disable") {
    if (installed) {
      await runServerNative(environment, "launchctl", ["disable", target]);
      files.remove(config.path);
    }
    return;
  }
  files.write(config.path, config.content, config.platform);
  await runServerNative(environment, "launchctl", ["enable", target]);
  await runServerNative(environment, "launchctl", ["bootstrap", domain, config.path]);
}

/**
 * Регистрирует/удаляет native user-service. Windows переиспользует существующий quiesce/COM/lock barrier,
 * но проверяет lifetime mutex именно этого Server, а не Git Sync supervisor.
 */
export async function controlServerService(
  action: "enable" | "disable",
  launch: ServerLaunch,
  environment: ServerEnvironment,
  binary = "",
): Promise<void> {
  const platform = environment.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new RelayError("SERVER_SERVICE_PLATFORM", messages.unsupported, 2);
  }
  const userName =
    platform === "win32"
      ? (environment.userName ??
        (await currentWindowsUser(environment).catch(serverServiceFailure)))
      : undefined;
  const config = createServerServiceConfiguration({
    platform,
    binary,
    launch,
    userHome: environment.userHome,
    ...(userName ? { userName } : {}),
  });
  const files = environment.serviceFiles ?? serviceFiles;
  const previous = files.read(config.path, platform);
  if (previous !== undefined && !previous.includes(config.marker)) {
    throw new RelayError("SERVER_SERVICE_OWNERSHIP", messages.ownership, 4, { path: config.path });
  }
  if (platform === "linux") {
    await linuxService(action, config, environment, previous !== undefined);
  } else if (platform === "darwin") {
    await macService(action, config, environment, previous !== undefined);
  } else {
    const windowsEnvironment = {
      ...environment,
      /**
       * Подключает общий Windows stop barrier к lifetime mutex именно этого экземпляра Server.
       */
      supervisorLockProbe: (): "free" | "busy" => probeServerLease(launch),
    };
    await windowsState(config, windowsEnvironment).catch(serverServiceFailure);
    if (action === "enable") {
      files.write(config.path, config.content, platform);
    }
    await windowsService(action, config, windowsEnvironment).catch(serverServiceFailure);
  }
}
