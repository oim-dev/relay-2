import { symlinkSync } from "node:fs";

/**
 * Создаёт macOS symlink чужого каталога для проверки запрета записи через алиас.
 */
export function macosDirectoryLink(target: string, link: string): void {
  symlinkSync(target, link, "dir");
}
