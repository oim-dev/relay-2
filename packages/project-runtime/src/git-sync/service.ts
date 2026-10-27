import { homedir } from "node:os";
import { RelayError } from "@relay/contracts";
import { validateOptions } from "../configuration/paths";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { selectUserService } from "../native/user-service/select";
import { ownsServiceConfiguration } from "../native/user-service/files";
import type { GitSyncEnvironment } from "./client.types";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { createServiceConfiguration, gitSyncServicePlatformFailure } from "./service-configuration";
import { createGitSyncServiceContext } from "./service-context";
import { probeGitSyncSupervisor, waitForGitSyncSupervisor } from "./supervisor";
import type { GitSyncServiceAction, GitSyncServiceStatus } from "./service.types";

const startup = {
  linux: messages.linuxLogin,
  darwin: messages.macLogin,
  win32: messages.windowsLogin,
};

/**
 * Разрешает home по синтаксису выбранного native-адаптера до обращения к manager.
 * Не читает переменные Relay; explicit platform не наследует правила путей хоста теста.
 */
export function gitSyncHome(options: RuntimeOptions, platform?: string): string {
  validateOptions(options);
  return selectUserService(platform, gitSyncServicePlatformFailure).resolveHome(
    options.cwd,
    options.home,
    homedir(),
  );
}

/**
 * Изменяет службу данного home, сохраняя проекты и подключения при disable.
 * Ownership файла проверяется до health/manager; enable требует новый совместимый instance,
 * а не только успешную регистрацию или health прежнего foreground supervisor.
 * Native manager владеет login/stop; приложение — readiness и точным lifetime mutex.
 */
export async function controlGitSyncService(
  action: GitSyncServiceAction,
  options: RuntimeOptions,
  environment: GitSyncEnvironment,
  binary = "",
): Promise<GitSyncServiceStatus> {
  const adapter = selectUserService(environment.platform, gitSyncServicePlatformFailure);
  if (!environment.userHome.trim()) {
    throw new RelayError("INVALID_ARGUMENT", messages.userHomeRequired, 2);
  }
  const home = gitSyncHome(options, adapter.platform);
  const context = createGitSyncServiceContext(environment, adapter, home);
  const userName = await adapter.resolveUserName(context, environment.userName || undefined);
  const config = createServiceConfiguration({
    platform: adapter.platform,
    binary,
    home,
    userHome: environment.userHome,
    ...(userName ? { userName } : {}),
  });
  const installed = ownsServiceConfiguration(config, context);
  const probeOptions = {
    version: environment.version,
    ...(environment.signal ? { signal: environment.signal } : {}),
    ...(environment.readinessTimeoutMs !== undefined
      ? { timeoutMs: environment.readinessTimeoutMs }
      : {}),
  };
  // Старый foreground instance не доказывает, что native manager запустил свою службу.
  const previous =
    action === "enable"
      ? await (environment.supervisorProbe
          ? environment.supervisorProbe(config.home, false)
          : probeGitSyncSupervisor(config.home, probeOptions))
      : undefined;
  const state = await adapter.control(action, config, context, installed);
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
  return {
    platform: adapter.platform,
    id: config.id,
    configPath: config.path,
    home: config.home,
    installed: action === "enable" || (action === "status" && installed),
    desiredRegistration:
      action === "enable" || (action === "status" && installed) ? "enabled" : "disabled",
    ...state,
    startup: startup[adapter.platform],
    supervisor,
  };
}
