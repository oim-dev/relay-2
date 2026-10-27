import { renameSync } from "node:fs";

/**
 * Публикует файл Linux rename: открытые читатели удерживают прежний inode.
 */
export function replaceLinuxFile(temporaryPath: string, targetPath: string): void {
  renameSync(temporaryPath, targetPath);
}
