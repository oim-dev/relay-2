import { renameSync } from "node:fs";

/**
 * Публикует private macOS БД переименованием под проверяемым SQLite-lock.
 * Namespace принадлежит fixture; no-replace гонку проверяет Runtime, не этот helper.
 */
export function publishMacosFixtureDatabase(source: string, target: string): void {
  renameSync(source, target);
}
