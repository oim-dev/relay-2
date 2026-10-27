import { symlinkSync } from "node:fs";

/**
 * Создаёт Windows junction каталога без требования привилегии файлового symlink.
 */
export function windowsDirectoryLink(target: string, link: string): void {
  symlinkSync(target, link, "junction");
}
