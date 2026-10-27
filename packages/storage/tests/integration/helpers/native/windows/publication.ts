import { linkSync } from "node:fs";

/**
 * Публикует Windows БД hardlink при открытом SQLite-handle, который запрещает rename.
 * Оба имени принадлежат fixture и удаляются ею только после закрытия всех соединений.
 */
export function publishWindowsFixtureDatabase(source: string, target: string): void {
  linkSync(source, target);
}
