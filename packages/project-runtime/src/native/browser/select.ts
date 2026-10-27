import { currentNativePlatform } from "../platform";
import type { NativePlatform } from "../platform.types";
import type { BrowserCommand } from "./browser.types";
import { linuxBrowserCommand } from "./linux";
import { macosBrowserCommand } from "./macos";
import { windowsBrowserCommand } from "./windows";

const implementations: Readonly<Record<NativePlatform, BrowserCommand>> = {
  linux: linuxBrowserCommand,
  darwin: macosBrowserCommand,
  win32: windowsBrowserCommand,
};

/**
 * Возвращает argv системного URL launcher, не запуская браузер или системные службы.
 */
export function nativeBrowserCommand(
  url: string,
  platform: NativePlatform = currentNativePlatform(),
): readonly [string, string] {
  return implementations[platform](url);
}
