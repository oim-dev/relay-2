import { renameSync } from "node:fs";

/**
 * Публикует файл штатным macOS rename без удаления назначения перед заменой.
 */
export function replaceMacosFile(temporaryPath: string, targetPath: string): void {
  renameSync(temporaryPath, targetPath);
}
