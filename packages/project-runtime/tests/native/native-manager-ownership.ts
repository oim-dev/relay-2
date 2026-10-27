import { existsSync, readFileSync } from "node:fs";
import type { NativeConfiguration } from "./native-service.types";

/**
 * Не допускает удаления чужого файла при fallback после отказа production cleanup.
 * До первого enable вызывающий отдельно подтверждает отсутствие ID в настоящем manager.
 */
export function assertOwnedConfiguration(
  config: NativeConfiguration,
  encoding: BufferEncoding,
): void {
  if (existsSync(config.path) && !readFileSync(config.path, encoding).includes(config.marker)) {
    throw new Error(`Аварийная уборка отвергла чужую конфигурацию ${config.path}`);
  }
}
