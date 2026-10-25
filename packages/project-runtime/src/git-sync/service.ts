import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { RelayError } from "@relay/contracts";
import { validateOptions } from "../configuration/paths";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import type { GitSyncEnvironment } from "./client.types";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { runServiceCommand as native } from "./service-command";
import { currentWindowsUser, windowsService, windowsState } from "./service-windows";
import { createServiceConfiguration } from "./service-configuration";
import { serviceFiles } from "./service-files";
import { probeGitSyncSupervisor, waitForGitSyncSupervisor } from "./supervisor";
import type {
  GitSyncServiceAction,
  GitSyncServiceStatus,
  ServiceConfiguration,
  ServicePlatform,
  NativeServiceStatus,
} from "./service.types";

/**
 * Разрешает home в синтаксисе выбранной платформы до обращения к native manager.
 * Не читает переменные Relay; explicit platform не наследует правила путей хоста теста.
 */
export function gitSyncHome(options: RuntimeOptions, platform: string = process.platform): string {
  validateOptions(options);
  const resolvePath = platform === "win32" ? win32.resolve : posix.resolve;
  return resolvePath(options.cwd, options.home ?? resolvePath(homedir(), ".relay"));
}

/**
 * Отвергает чужую конфигурацию до любого изменения native manager или файлов.
 */
function owned(configuration: ServiceConfiguration, environment: GitSyncEnvironment): boolean {
  const content = (environment.serviceFiles ?? serviceFiles).read(
    configuration.path,
    configuration.platform,
  );
  if (content !== undefined && !content.includes(configuration.marker)) {
    throw new RelayError("GIT_SYNC_SERVICE_OWNERSHIP", messages.serviceOwnership, 4, {
      path: configuration.path,
    });
  }
  return content !== undefined;
}

/**
 * Возвращает только поддержанную платформу; foreground не требует системного менеджера.
 */
function servicePlatform(environment: GitSyncEnvironment): ServicePlatform {
  const platform = environment.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new RelayError("GIT_SYNC_SERVICE_PLATFORM", messages.servicePlatform, 2);
  }
  return platform;
}

/**
 * Управляет user-systemd: enable запускает службу сейчас и включает следующий login.
 */
async function linuxService(
  action: GitSyncServiceAction,
  config: ServiceConfiguration,
  environment: GitSyncEnvironment,
  installed: boolean,
): Promise<NativeServiceStatus> {
  if (action === "disable") {
    if (installed) {
      await native(environment, "systemctl", ["--user", "disable", "--now", config.id]);
      (environment.serviceFiles ?? serviceFiles).remove(config.path);
      await native(environment, "systemctl", ["--user", "daemon-reload"]);
      return { registered: false, enabled: false, state: "stopped", managerExitCode: 0 };
    }
  }
  if (action === "enable") {
    await native(environment, "systemctl", ["--user", "daemon-reload"]);
    await native(environment, "systemctl", ["--user", "enable", "--now", config.id]);
    // Обновление exact binary/home вступает в силу и для уже работающего supervisor.
    if (installed) {
      await native(environment, "systemctl", ["--user", "restart", config.id]);
    }
  }
  const status = await native(
    environment,
    "systemctl",
    ["--user", "show", config.id, "--property=LoadState,ActiveState,UnitFileState", "--no-pager"],
    [0, 4],
  );
  const fields = Object.fromEntries(
    status.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  if (fields.LoadState === "not-found") {
    return {
      registered: false,
      enabled: false,
      state: "stopped",
      managerExitCode: status.exitCode,
    };
  }
  if (status.exitCode !== 0 || !fields.LoadState || !fields.ActiveState) {
    throw new RelayError("GIT_SYNC_SERVICE_FAILED", messages.nativeFailed, status.exitCode || 1, {
      nativeExitCode: status.exitCode,
      stderr: status.stderr,
      stdout: status.stdout,
    });
  }
  let state: NativeServiceStatus["state"] = "stopped";
  if (fields.ActiveState === "active") {
    state = "running";
  } else if (fields.ActiveState === "activating" || fields.ActiveState === "deactivating") {
    state = "unknown";
  }
  return {
    registered: true,
    enabled: fields.UnitFileState
      ? ["enabled", "enabled-runtime"].includes(fields.UnitFileState)
      : null,
    state,
    managerExitCode: status.exitCode,
  };
}

/**
 * Управляет LaunchAgent только gui-сессии текущего UID, с прямым bootstrap/kickstart.
 */
async function macService(
  action: GitSyncServiceAction,
  config: ServiceConfiguration,
  environment: GitSyncEnvironment,
  installed: boolean,
): Promise<NativeServiceStatus> {
  const uid = environment.userId ?? process.getuid?.();
  if (uid === undefined) {
    throw new RelayError("GIT_SYNC_SERVICE_IDENTITY", messages.serviceIdentity);
  }
  const domain = `gui/${uid}`;
  const target = `${domain}/${config.id}`;
  // Проверка домена отделяет отсутствие GUI-сессии от отсутствия собственного LaunchAgent.
  await native(environment, "launchctl", ["print", domain]);
  const current = await native(environment, "launchctl", ["print", target], [0, 113]);
  if (action === "status") {
    // launchctl print — диагностический текст, не API liveness. Код 0 подтверждает только загрузку.
    return {
      registered: current.exitCode === 0,
      enabled: null,
      state: current.exitCode === 0 ? "unknown" : "stopped",
      managerExitCode: current.exitCode,
    };
  }
  if (!installed && action === "disable") {
    return {
      registered: current.exitCode === 0,
      enabled: null,
      state: current.exitCode === 0 ? "unknown" : "stopped",
      managerExitCode: current.exitCode,
    };
  }
  if (!installed && current.exitCode === 0 && action === "enable") {
    throw new RelayError("GIT_SYNC_SERVICE_OWNERSHIP", messages.serviceOwnership, 4, {
      id: config.id,
    });
  }
  if (action === "enable") {
    (environment.serviceFiles ?? serviceFiles).write(config.path, config.content, config.platform);
  }
  if (current.exitCode === 0) {
    await native(environment, "launchctl", ["bootout", target]);
  }
  if (action === "disable") {
    await native(environment, "launchctl", ["disable", target]);
    (environment.serviceFiles ?? serviceFiles).remove(config.path);
    return { registered: false, enabled: false, state: "stopped", managerExitCode: 0 };
  }
  await native(environment, "launchctl", ["enable", target]);
  await native(environment, "launchctl", ["bootstrap", domain, config.path]);
  await native(environment, "launchctl", ["kickstart", "-k", target]);
  return { registered: true, enabled: true, state: "unknown", managerExitCode: 0 };
}

/**
 * Изменяет только службу данного home; disable сохраняет базы, подключения и рабочие каталоги.
 * Никакого sudo, linger или изменения окружения пользователя контроллер не выполняет.
 */
export async function controlGitSyncService(
  action: GitSyncServiceAction,
  options: RuntimeOptions,
  environment: GitSyncEnvironment,
  binary = "",
): Promise<GitSyncServiceStatus> {
  const platform = servicePlatform(environment);
  if (!environment.userHome.trim()) {
    throw new RelayError("INVALID_ARGUMENT", messages.userHomeRequired, 2);
  }
  let userName = environment.userName;
  if (platform === "win32" && !userName) {
    userName = await currentWindowsUser(environment);
  }
  const config = createServiceConfiguration({
    platform,
    binary,
    home: gitSyncHome(options, platform),
    userHome: environment.userHome,
    ...(userName ? { userName } : {}),
  });
  const installed = owned(config, environment);
  const probeOptions = {
    version: environment.version,
    ...(environment.signal ? { signal: environment.signal } : {}),
    ...(environment.readinessTimeoutMs !== undefined
      ? { timeoutMs: environment.readinessTimeoutMs }
      : {}),
  };
  // Уже работающий foreground supervisor не доказывает, что native manager запустил свою службу.
  const previous =
    action === "enable"
      ? await (environment.supervisorProbe
          ? environment.supervisorProbe(config.home, false)
          : probeGitSyncSupervisor(config.home, probeOptions))
      : undefined;
  if (action === "enable") {
    // До публикации Windows проверяет также владельца уже зарегистрированной задачи.
    if (platform === "win32") {
      await windowsState(config, environment);
    }
    if (
      platform === "linux" &&
      !installed &&
      (await linuxService("status", config, environment, false)).registered
    ) {
      throw new RelayError("GIT_SYNC_SERVICE_OWNERSHIP", messages.serviceOwnership, 4, {
        id: config.id,
      });
    }
    // LaunchAgent проверяет отсутствие чужого загруженного label перед собственной публикацией.
    if (platform !== "darwin") {
      (environment.serviceFiles ?? serviceFiles).write(config.path, config.content, platform);
    }
  }
  let state: NativeServiceStatus;
  if (platform === "linux") {
    state = await linuxService(action, config, environment, installed);
  } else if (platform === "darwin") {
    state = await macService(action, config, environment, installed);
  } else {
    state = await windowsService(action, config, environment);
  }
  // Task Scheduler может ещё показывать Ready после регистрации; готовность подтверждает health ниже.
  if (action === "enable" && (!state.registered || state.enabled === false)) {
    throw new RelayError("GIT_SYNC_NOT_READY", messages.supervisorNotReady, 4, {
      home: config.home,
      native: state,
    });
  }
  const supervisor = environment.supervisorProbe
    ? await environment.supervisorProbe(config.home, action === "enable")
    : await (action === "enable" ? waitForGitSyncSupervisor : probeGitSyncSupervisor)(config.home, {
        ...probeOptions,
        ...(previous?.instance ? { previousInstance: previous.instance } : {}),
      });
  if (
    action === "enable" &&
    (!supervisor.responsive || supervisor.instance === previous?.instance)
  ) {
    throw new RelayError("GIT_SYNC_NOT_READY", messages.supervisorNotReady, 4, {
      home: config.home,
      supervisor,
    });
  }
  const startup = {
    linux: messages.linuxLogin,
    darwin: messages.macLogin,
    win32: messages.windowsLogin,
  };
  return {
    platform,
    id: config.id,
    configPath: config.path,
    home: config.home,
    installed: action === "enable" || (action === "status" && installed),
    desiredRegistration:
      action === "enable" || (action === "status" && installed) ? "enabled" : "disabled",
    ...state,
    startup: startup[platform],
    supervisor,
  };
}
