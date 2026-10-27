import { posix } from "node:path";
import { createLinuxServiceConfiguration } from "../service-configuration/linux";
import { runUserServiceCommand as native } from "./command";
import { createUserServiceFiles } from "./files";
import type {
  NativeServiceStatus,
  ServiceConfiguration,
  UserServiceAction,
  UserServiceAdapter,
  UserServiceContext,
} from "./service.types";

/**
 * Читает машинные свойства systemd; повреждённый ответ не считается остановленной службой.
 */
async function linuxState(
  config: ServiceConfiguration,
  context: UserServiceContext,
): Promise<NativeServiceStatus> {
  const status = await native(
    context,
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
    throw context.failure("command", status.exitCode || 1, {
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
 * Публикует проверенный unit и запускает его; повтор enable применяет обновлённые executable/argv.
 * Файл сохраняется при отказе менеджера, позволяя диагностировать и повторить явный enable.
 */
async function enableLinuxService(
  config: ServiceConfiguration,
  context: UserServiceContext,
  installed: boolean,
  failureExitCode?: number,
): Promise<void> {
  context.files.write(config.path, config.content);
  await native(context, "systemctl", ["--user", "daemon-reload"], [0], failureExitCode);
  await native(
    context,
    "systemctl",
    ["--user", "enable", "--now", config.id],
    [0],
    failureExitCode,
  );
  if (installed) {
    await native(context, "systemctl", ["--user", "restart", config.id], [0], failureExitCode);
  }
}

/**
 * Удаляет только проверенный unit после успешного disable --now; отказ stop сохраняет файл.
 */
async function disableLinuxService(
  config: ServiceConfiguration,
  context: UserServiceContext,
  failureExitCode?: number,
): Promise<void> {
  await native(
    context,
    "systemctl",
    ["--user", "disable", "--now", config.id],
    [0],
    failureExitCode,
  );
  context.files.remove(config.path);
  await native(context, "systemctl", ["--user", "daemon-reload"], [0], failureExitCode);
}

/**
 * Управляет наблюдаемой службой supervisor; отсутствие своего файла при disable не удаляет native unit.
 * Проверка чужой регистрации выполняется до публикации, а status не изменяет manager.
 */
async function controlLinuxService(
  action: UserServiceAction,
  config: ServiceConfiguration,
  context: UserServiceContext,
  installed: boolean,
): Promise<NativeServiceStatus> {
  if (action === "enable") {
    if (!installed && (await linuxState(config, context)).registered) {
      throw context.failure("ownership", 4, { id: config.id });
    }
    await enableLinuxService(config, context, installed);
  }
  if (action === "disable" && installed) {
    await disableLinuxService(config, context);
    return { registered: false, enabled: false, state: "stopped", managerExitCode: 0 };
  }
  return linuxState(config, context);
}

/**
 * Меняет регистрацию Server без дополнительного status/readiness.
 * Отсутствие собственного файла требует отсутствующего native unit даже при disable.
 * Ошибки команды сохраняют прежний Server exit 4 и nativeExitCode в details.
 */
async function registerLinuxService(
  action: "enable" | "disable",
  config: ServiceConfiguration,
  context: UserServiceContext,
  installed: boolean,
): Promise<void> {
  const current = await native(
    context,
    "systemctl",
    ["--user", "show", config.id, "--property=LoadState", "--no-pager"],
    [0, 4],
    4,
  );
  if (!installed && current.stdout.trim() !== "LoadState=not-found") {
    throw context.failure("ownership", 4, { id: config.id });
  }
  if (action === "disable") {
    if (installed) {
      await disableLinuxService(config, context, 4);
    }
    return;
  }
  await enableLinuxService(config, context, installed, 4);
}

/**
 * Linux user-systemd: UTF-8 unit, POSIX paths и namespace домашнего каталога.
 */
export const linuxUserService: UserServiceAdapter = {
  platform: "linux",
  files: createUserServiceFiles("utf8", ""),
  /**
   * Разрешает относительный home по POSIX, не наследуя Windows-синтаксис хоста теста.
   */
  resolveHome: (cwd, home, userHome): string =>
    posix.resolve(cwd, home ?? posix.resolve(userHome, ".relay")),
  /**
   * systemd --user уже ограничивает namespace текущим пользователем.
   */
  scopeIdentity: (home): string => home,
  /**
   * systemd не требует отдельного DOMAIN\user.
   */
  resolveUserName: async (_context, userName): Promise<string | undefined> => userName,
  configure: createLinuxServiceConfiguration,
  control: controlLinuxService,
  register: registerLinuxService,
};
