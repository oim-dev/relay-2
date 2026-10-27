import { renameSync } from "node:fs";

/**
 * Публикует private Linux БД переименованием под проверяемым SQLite-lock.
 * Namespace принадлежит fixture; no-replace гонку проверяет Runtime, не этот helper.
 */
export function publishLinuxFixtureDatabase(source: string, target: string): void {
  renameSync(source, target);
}
