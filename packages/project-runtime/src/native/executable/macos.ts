import { accessSync, constants } from "node:fs";
import type { ExecutablePlatform } from "./executable.types";

/**
 * macOS использует executable bit и регистрозависимое имя PATH.
 */
export const macosExecutable: ExecutablePlatform = {
  suffix: "",
  /**
   * Требует право исполнения файла.
   */
  checkAccess(path): void {
    accessSync(path, constants.X_OK);
  },
  /**
   * Читает macOS PATH без изменения глобального окружения.
   */
  searchPath(environment): readonly string[] {
    return (environment.PATH ?? "").split(":").filter(Boolean);
  },
};
