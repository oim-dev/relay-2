import { renameSync } from "node:fs";
import { replaceWithWindowsOpenReaders } from "./windows-native";

/**
 * После Windows EPERM применяет одну native-замену с FILE_SHARE_DELETE у читателей.
 * Назначение не удаляется; таймерные повторы и копирование файла не используются.
 */
export function replaceWindowsFile(temporaryPath: string, targetPath: string): void {
  try {
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") {
      throw error;
    }
    replaceWithWindowsOpenReaders(temporaryPath, targetPath);
  }
}
