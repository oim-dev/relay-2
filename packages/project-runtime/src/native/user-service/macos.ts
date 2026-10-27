import { posix } from "node:path";
import { createMacosServiceConfiguration } from "../service-configuration/macos";
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
 * Определяет GUI domain текущего UID, не подменяя отсутствующую login-сессию системным domain.
 */
function launchDomain(context: UserServiceContext, identityExitCode: number): string {
  const uid = context.userId ?? process.getuid?.();
  if (uid === undefined) {
    throw context.failure("identity", identityExitCode);
  }
  return `gui/${uid}`;
}

/**
 * Наблюдает только наличие launchd job: диагностический print не является машинным API liveness.
 */
function launchStatus(exitCode: number): NativeServiceStatus {
  return {
    registered: exitCode === 0,
    enabled: null,
    state: exitCode === 0 ? "unknown" : "stopped",
    managerExitCode: exitCode,
  };
}

/**
 * Управляет supervisor через bootstrap/kickstart. Перед публикацией проверяет чужой loaded label;
 * свой файл публикуется до bootout, чтобы отказ остановки оставался диагностируемым.
 */
async function controlMacosService(
  action: UserServiceAction,
  config: ServiceConfiguration,
  context: UserServiceContext,
  installed: boolean,
): Promise<NativeServiceStatus> {
  const domain = launchDomain(context, 1);
  const target = `${domain}/${config.id}`;
  await native(context, "launchctl", ["print", domain]);
  const current = await native(context, "launchctl", ["print", target], [0, 113]);
  if (action === "status" || (!installed && action === "disable")) {
    return launchStatus(current.exitCode);
  }
  if (!installed && current.exitCode === 0 && action === "enable") {
    throw context.failure("ownership", 4, { id: config.id });
  }
  if (action === "enable") {
    context.files.write(config.path, config.content);
  }
  if (current.exitCode === 0) {
    await native(context, "launchctl", ["bootout", target]);
  }
  if (action === "disable") {
    await native(context, "launchctl", ["disable", target]);
    context.files.remove(config.path);
    return { registered: false, enabled: false, state: "stopped", managerExitCode: 0 };
  }
  await native(context, "launchctl", ["enable", target]);
  await native(context, "launchctl", ["bootstrap", domain, config.path]);
  await native(context, "launchctl", ["kickstart", "-k", target]);
  return { registered: true, enabled: true, state: "unknown", managerExitCode: 0 };
}

/**
 * Меняет регистрацию Server: bootout предшествует публикации, bootstrap запускает RunAtLoad без kickstart.
 * Чужой loaded label запрещает как enable, так и disable; ошибки команды сохраняют Server exit 4.
 */
async function registerMacosService(
  action: "enable" | "disable",
  config: ServiceConfiguration,
  context: UserServiceContext,
  installed: boolean,
): Promise<void> {
  const domain = launchDomain(context, 2);
  const target = `${domain}/${config.id}`;
  await native(context, "launchctl", ["print", domain], [0], 4);
  const current = await native(context, "launchctl", ["print", target], [0, 113], 4);
  if (!installed && current.exitCode === 0) {
    throw context.failure("ownership", 4, { id: config.id });
  }
  if (current.exitCode === 0) {
    await native(context, "launchctl", ["bootout", target], [0], 4);
  }
  if (action === "disable") {
    if (installed) {
      await native(context, "launchctl", ["disable", target], [0], 4);
      context.files.remove(config.path);
    }
    return;
  }
  context.files.write(config.path, config.content);
  await native(context, "launchctl", ["enable", target], [0], 4);
  await native(context, "launchctl", ["bootstrap", domain, config.path], [0], 4);
}

/**
 * macOS LaunchAgent: UTF-8 plist, POSIX paths и только GUI-сессия текущего пользователя.
 */
export const macosUserService: UserServiceAdapter = {
  platform: "darwin",
  files: createUserServiceFiles("utf8", ""),
  /**
   * Разрешает home по POSIX без выбора platform в приложении.
   */
  resolveHome: (cwd, home, userHome): string =>
    posix.resolve(cwd, home ?? posix.resolve(userHome, ".relay")),
  /**
   * GUI domain уже ограничивает namespace текущим пользователем.
   */
  scopeIdentity: (home): string => home,
  /**
   * launchd использует UID, а не DOMAIN\user.
   */
  resolveUserName: async (_context, userName): Promise<string | undefined> => userName,
  configure: createMacosServiceConfiguration,
  control: controlMacosService,
  register: registerMacosService,
};
