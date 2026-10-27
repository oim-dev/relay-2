import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { NativeCommands } from "../native-command";
import type { NativeSession } from "../native-service.types";

/**
 * Передаёт адрес существующего user bus; не создаёт сессию и не включает linger.
 */
export function linuxEnvironment(): Readonly<Record<string, string | undefined>> {
  const env = { ...process.env };
  env.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid?.()}`;
  env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
  return env;
}

/**
 * Проверяет user-systemd и фиксирует login-политику только чтениями без root/sudo.
 */
export async function preflightLinuxSession(commands: NativeCommands): Promise<NativeSession> {
  const userHome = realpathSync(userInfo().homedir);
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    throw new Error(
      "NATIVE_SERVICE_SESSION_REQUIRED: нужен непривилегированный POSIX-пользователь",
    );
  }
  if (realpathSync(commands.env.HOME ?? userHome) !== userHome) {
    throw new Error(
      "NATIVE_SERVICE_SESSION_REQUIRED: HOME должен принадлежать текущему пользователю",
    );
  }
  if (commands.env.XDG_CONFIG_HOME && commands.env.XDG_CONFIG_HOME !== join(userHome, ".config")) {
    throw new Error("NATIVE_SERVICE_SESSION_REQUIRED: нужен стандартный user-systemd config path");
  }
  await commands.run("systemctl", ["--user", "show", "--property=Version", "--no-pager"]);
  return { userHome, uid, linger: await readLinger(commands, uid) };
}

/**
 * Читает login-политику до и после сценария; неожиданный ответ не подменяется default.
 */
export async function readLinger(commands: NativeCommands, uid: number): Promise<string> {
  const result = await commands.run("loginctl", [
    "show-user",
    String(uid),
    "--property=Linger",
    "--value",
  ]);
  const linger = result.stdout.trim();
  if (linger !== "yes" && linger !== "no") {
    throw new Error(`NATIVE_SERVICE_SESSION_REQUIRED: неизвестная политика Linger: ${linger}`);
  }
  return linger;
}
