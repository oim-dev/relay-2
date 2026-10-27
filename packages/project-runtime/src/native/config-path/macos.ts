import { realpathSync } from "node:fs";

/**
 * Получает физическое имя штатным macOS realpath, сохраняя нативную семантику ссылок.
 */
export function macosConfigPath(path: string): string {
  return realpathSync(path);
}
