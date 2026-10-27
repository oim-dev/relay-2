import { RelayError } from "@relay/contracts";
import { platformMessages } from "./platform.messages";
import type { NativePlatform } from "./platform.types";

/**
 * Проверяет имя платформы без обращения к ОС; неизвестное имя не получает POSIX fallback.
 */
export function parseNativePlatform(value: string): NativePlatform | undefined {
  switch (value) {
    case "linux":
    case "darwin":
    case "win32":
      return value;
    default:
      return undefined;
  }
}

/**
 * Единственная production-граница определения ОС хоста. Ресурсы адаптеров не открывает.
 */
export function currentNativePlatform(): NativePlatform {
  const platform = parseNativePlatform(process.platform);
  if (platform === undefined) {
    throw new RelayError("PLATFORM_UNSUPPORTED", platformMessages.unsupported, 2, {
      platform: process.platform,
    });
  }
  return platform;
}
