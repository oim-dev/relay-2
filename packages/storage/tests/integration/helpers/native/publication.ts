import { publishLinuxFixtureDatabase } from "./linux/publication";
import { publishMacosFixtureDatabase } from "./macos/publication";
import { publishWindowsFixtureDatabase } from "./windows/publication";

/**
 * Выбирает независимое от production Runtime действие публикации под SQLite-барьером Storage.
 * Storage не зависит от Runtime; неподдерживаемая ОС не получает неявный POSIX fallback.
 */
export function publishFixtureDatabase(source: string, target: string): void {
  switch (process.platform) {
    case "linux":
      return publishLinuxFixtureDatabase(source, target);
    case "darwin":
      return publishMacosFixtureDatabase(source, target);
    case "win32":
      return publishWindowsFixtureDatabase(source, target);
    default:
      throw new Error(`Неподдерживаемая платформа SQLite fixture: ${process.platform}`);
  }
}
