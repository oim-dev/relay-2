import { realpathSync, statSync } from "node:fs";
import { currentNativePlatform } from "../platform";
import type { NativePlatform } from "../platform.types";
import type { ExecutablePlatform } from "./executable.types";
import { linuxExecutable } from "./linux";
import { macosExecutable } from "./macos";
import { windowsExecutable } from "./windows";

const implementations: Readonly<Record<NativePlatform, ExecutablePlatform>> = {
  linux: linuxExecutable,
  darwin: macosExecutable,
  win32: windowsExecutable,
};

/**
 * Возвращает имя собираемого бинарника для выбранной ОС. base не содержит расширение .exe.
 */
export function nativeExecutableName(
  base: string,
  platform: NativePlatform = currentNativePlatform(),
): string {
  return base + implementations[platform].suffix;
}

/**
 * Выбирает каталоги поиска бинарников из явного окружения по правилам хоста.
 */
export function nativeExecutableSearchPath(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return implementations[currentNativePlatform()].searchPath(environment);
}

/**
 * Проверяет обычный исполняемый файл и возвращает физическое имя. Отсутствие или запрет
 * доступа допускают следующий кандидат; неожиданные ошибки не маскируются.
 */
export function resolveNativeExecutable(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) {
      return undefined;
    }
    implementations[currentNativePlatform()].checkAccess(path);
    return realpathSync(path);
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ENOTDIR", "EACCES"].includes(String(cause.code))
    ) {
      return undefined;
    }
    throw cause;
  }
}
