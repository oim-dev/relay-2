import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { NativeCommands } from "./native-command";
import type { NativePlatform, NativeSession } from "./native-service.types";

/**
 * Отклоняет случайный локальный запуск до создания fixture и обращения к manager.
 * Флаг означает явное согласие на регистрацию своей службы в одноразовом CI-пользователе.
 */
export function requireNativeServiceOptIn(): NativePlatform {
  if (process.env.RELAY_NATIVE_SERVICE_TESTS !== "disposable-runner" || process.env.CI !== "true") {
    throw new Error(
      "NATIVE_SERVICE_OPT_IN_REQUIRED: нужны CI=true и RELAY_NATIVE_SERVICE_TESTS=disposable-runner на одноразовом runner",
    );
  }
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error(`NATIVE_SERVICE_UNSUPPORTED: ${platform}`);
  }
  const expected = process.env.RELAY_NATIVE_SERVICE_PLATFORM;
  if (expected && platform !== expected) {
    throw new Error(
      `NATIVE_SERVICE_PLATFORM_MISMATCH: ожидалась ${expected}, получена ${platform}`,
    );
  }
  return platform;
}

/**
 * Передаёт адрес уже существующего user bus; не создаёт сессию и не включает linger.
 * Настоящий HOME необходим для поиска установленного unit менеджером, в отличие от RELAY_HOME.
 */
export function nativeEnvironment(
  platform: NativePlatform,
): Readonly<Record<string, string | undefined>> {
  const env = { ...process.env };
  if (platform === "linux") {
    env.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid?.()}`;
    env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
  }
  return env;
}

/**
 * Проверяет существующий manager только чтениями. Отсутствие сессии — ошибка набора, не skip.
 * Пароли, login, sudo, UAC и политика ОС этим preflight не изменяются.
 */
export async function preflightNativeSession(
  platform: NativePlatform,
  commands: NativeCommands,
): Promise<NativeSession> {
  const userHome = realpathSync(userInfo().homedir);
  if (platform === "win32") {
    const identity = await commands.powershell(`
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$session=(Get-Process -Id $PID).SessionId
$interactive=@($identity.Groups | ForEach-Object { $_.Value }) -contains 'S-1-5-4'
if ($session -eq 0 -or -not $interactive) {
  throw 'NATIVE_SERVICE_SESSION_REQUIRED: нужен runner текущего пользователя в уже открытой интерактивной Windows-сессии; service Session 0 не подходит'
}
$scheduler=New-Object -ComObject Schedule.Service
$scheduler.Connect()
@{ userName=$identity.Name; sessionId=$session; scheduler=$scheduler.Connected } | ConvertTo-Json -Compress
`);
    if (
      !identity ||
      typeof identity !== "object" ||
      !("userName" in identity) ||
      typeof identity.userName !== "string" ||
      !identity.userName.trim() ||
      !("scheduler" in identity) ||
      identity.scheduler !== true
    ) {
      throw new Error("NATIVE_SERVICE_SESSION_REQUIRED: нет текущего пользователя Task Scheduler");
    }
    return { userHome, userName: identity.userName, uid: null, linger: null };
  }

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
  if (platform === "darwin") {
    await commands.run("launchctl", ["print", `gui/${uid}`]);
    return { userHome, uid, linger: null };
  }
  if (commands.env.XDG_CONFIG_HOME && commands.env.XDG_CONFIG_HOME !== join(userHome, ".config")) {
    throw new Error("NATIVE_SERVICE_SESSION_REQUIRED: нужен стандартный user-systemd config path");
  }
  await commands.run("systemctl", ["--user", "show", "--property=Version", "--no-pager"]);
  const linger = await readLinger(commands, uid);
  return { userHome, uid, linger };
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
