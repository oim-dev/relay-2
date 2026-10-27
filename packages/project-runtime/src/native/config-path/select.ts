import { currentNativePlatform } from "../platform";
import type { NativePlatform } from "../platform.types";
import type { PhysicalConfigPath } from "./config-path.types";
import { linuxConfigPath } from "./linux";
import { macosConfigPath } from "./macos";
import { windowsConfigPath } from "./windows";

const implementations: Readonly<Record<NativePlatform, PhysicalConfigPath>> = {
  linux: linuxConfigPath,
  darwin: macosConfigPath,
  win32: windowsConfigPath,
};

/**
 * Разрешает имя конфигурации нативным алгоритмом хоста без изменения файлов.
 */
export function physicalConfigPath(path: string): string {
  return implementations[currentNativePlatform()](path);
}
