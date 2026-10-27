import { currentNativePlatform } from "../platform";
import type { NativePlatform } from "../platform.types";
import type { ProcessLifetime, ProcessTreeCapability } from "./lifetime.types";
import { linuxProcessLifetime } from "./linux";
import { macosProcessLifetime } from "./macos";
import { windowsProcessLifetime } from "./windows";

const implementations: Readonly<Record<NativePlatform, ProcessLifetime>> = {
  linux: linuxProcessLifetime,
  darwin: macosProcessLifetime,
  win32: windowsProcessLifetime,
};

/**
 * Выбирает native lifecycle хоста; загрузка библиотек отложена до назначения контейнера.
 */
export function nativeProcessLifetime(): ProcessLifetime {
  return implementations[currentNativePlatform()];
}

/**
 * Возвращает фактическую гарантию того же адаптера, который исполняет команды.
 */
export function nativeProcessTreeCapability(): ProcessTreeCapability {
  return nativeProcessLifetime().capability;
}
