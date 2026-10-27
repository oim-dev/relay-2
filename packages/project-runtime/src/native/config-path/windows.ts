import { realpathSync } from "node:fs";

/**
 * Канонизирует полное Windows-имя, включая файловые алиасы 8.3 и junctions.
 * Разрешение только родителя потеряло бы идентичность конечного short name.
 */
export function windowsConfigPath(path: string): string {
  return realpathSync(path);
}
