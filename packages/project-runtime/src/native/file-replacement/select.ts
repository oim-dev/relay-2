import { currentNativePlatform } from "../platform";
import type { NativePlatform } from "../platform.types";
import { replaceLinuxFile } from "./linux";
import { replaceMacosFile } from "./macos";
import { replaceWindowsFile } from "./windows";
import type { ReplaceFile } from "./replacement.types";

const implementations: Readonly<Record<NativePlatform, ReplaceFile>> = {
  linux: replaceLinuxFile,
  darwin: replaceMacosFile,
  win32: replaceWindowsFile,
};

/**
 * Возвращает механизм атомарной замены хоста; native-библиотеки открываются лишь при операции.
 */
export function nativeFileReplacement(): ReplaceFile {
  return implementations[currentNativePlatform()];
}
