import { currentNativePlatform, type NativePlatform } from "@relay/project-runtime";
import type { GitPlatform } from "./git-platform.types";
import { linuxGitPlatform } from "./linux";
import { macosGitPlatform } from "./macos";
import { windowsGitPlatform } from "./windows";

const implementations: Readonly<Record<NativePlatform, GitPlatform>> = {
  linux: linuxGitPlatform,
  darwin: macosGitPlatform,
  win32: windowsGitPlatform,
};

/**
 * Выбирает Git-адаптер отдельно от runtime-механизмов ОС. Явная платформа нужна чистым проверкам.
 */
export function nativeGitPlatform(platform: NativePlatform = currentNativePlatform()): GitPlatform {
  return implementations[platform];
}

/**
 * Отличает SSH remote от локального синтаксиса выбранной ОС, HTTP и других протоколов.
 */
export function usesSsh(remote: string, platform?: NativePlatform): boolean {
  return nativeGitPlatform(platform).usesSsh(remote);
}

/**
 * Кодирует собственное контролируемое argv для Git shell; пользовательские overrides не изменяет.
 */
export function shellWord(value: string, platform?: NativePlatform): string {
  return nativeGitPlatform(platform).shellWord(value);
}
