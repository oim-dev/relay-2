import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectLocation } from "@relay/project-runtime";

/**
 * Подготавливает созревшее локальное расписание и Git-маркер выбранного проекта без Git-процессов.
 * Предметные записи не меняются; собственное SQLite-соединение закрывается до HTTP-запроса.
 * Обмен остаётся внешним портом: эти тесты проверяют порядок HTTP/Core, а не Git-транспорт.
 */
export function prepareDueSynchronization(location: ProjectLocation): void {
  mkdirSync(join(dirname(location.configPath), ".git"), { recursive: true });
  const database = new Database(location.databasePath);
  try {
    database.exec(
      "UPDATE synchronization_schedule SET dirty_since=0,last_mutation_at=0,next_attempt_at=0",
    );
  } finally {
    database.close();
  }
}
