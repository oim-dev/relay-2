import { accessSync, constants } from "node:fs";
import type { ExecutablePlatform } from "./executable.types";

/**
 * Windows запускает .exe, не использует POSIX executable bit и принимает Path/PATH.
 */
export const windowsExecutable: ExecutablePlatform = {
  suffix: ".exe",
  /**
   * Проверяет наличие; native loader проверит возможность исполнения PE.
   */
  checkAccess(path): void {
    accessSync(path, constants.F_OK);
  },
  /**
   * Сохраняет прежний выбор первого регистронезависимого ключа PATH.
   */
  searchPath(environment): readonly string[] {
    const key = Object.keys(environment).find((name) => name.toUpperCase() === "PATH");
    return (key ? (environment[key] ?? "") : "").split(";").filter(Boolean);
  },
};
