import { RelayError } from "@relay/contracts";
import { currentNativePlatform, parseNativePlatform } from "../platform";
import type { NativePlatform } from "../platform.types";
import { linuxUserService } from "./linux";
import { macosUserService } from "./macos";
import { windowsUserService } from "./windows";
import type { UserServiceAdapter } from "./service.types";

const implementations: Readonly<Record<NativePlatform, UserServiceAdapter>> = {
  linux: linuxUserService,
  darwin: macosUserService,
  win32: windowsUserService,
};

/**
 * Единственная точка выбора реализации service. Unknown platform не получает POSIX fallback;
 * фабрика отказа сохраняет публичный код приложения, включая неподдержанную ОС хоста.
 */
export function selectUserService(
  platform: string | undefined,
  unsupported: () => Error,
): UserServiceAdapter {
  let selected: NativePlatform | undefined;
  try {
    selected = platform === undefined ? currentNativePlatform() : parseNativePlatform(platform);
  } catch (error) {
    if (!(error instanceof RelayError) || error.code !== "PLATFORM_UNSUPPORTED") {
      throw error;
    }
    throw unsupported();
  }
  if (selected === undefined) {
    throw unsupported();
  }
  return implementations[selected];
}
