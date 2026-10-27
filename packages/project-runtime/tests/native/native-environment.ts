import { parseNativePlatform, type NativePlatform } from "@relay/project-runtime";
import type { NativeCommands } from "./native-command";
import type { NativeSession } from "./native-service.types";
import { linuxEnvironment, preflightLinuxSession } from "./linux/environment";
import { preflightMacosSession } from "./macos/environment";
import { preflightWindowsSession } from "./windows/environment";

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
  const platform = parseNativePlatform(process.platform);
  if (platform === undefined) {
    throw new Error(`NATIVE_SERVICE_UNSUPPORTED: ${process.platform}`);
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
 * Создаёт окружение чтений manager без изменения глобальных переменных и login-политики ОС.
 * Настоящий HOME необходим для поиска установленной службы, в отличие от RELAY_HOME.
 */
export function nativeEnvironment(
  platform: NativePlatform,
): Readonly<Record<string, string | undefined>> {
  return platform === "linux" ? linuxEnvironment() : { ...process.env };
}

/**
 * Выбирает readonly preflight существующей native-сессии. Отсутствие сессии — ошибка, не skip.
 * Пароли, login, sudo, UAC и политика ОС этим preflight не изменяются.
 */
export async function preflightNativeSession(
  platform: NativePlatform,
  commands: NativeCommands,
): Promise<NativeSession> {
  switch (platform) {
    case "linux":
      return preflightLinuxSession(commands);
    case "darwin":
      return preflightMacosSession(commands);
    case "win32":
      return preflightWindowsSession(commands);
  }
}
