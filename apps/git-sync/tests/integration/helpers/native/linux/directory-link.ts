import { symlinkSync } from "node:fs";

/**
 * Создаёт Linux symlink чужого каталога в изолированной fixture, не меняя его содержимое.
 */
export function linuxDirectoryLink(target: string, link: string): void {
  symlinkSync(target, link, "dir");
}
