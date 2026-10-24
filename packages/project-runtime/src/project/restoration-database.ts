import { RelayError } from "@relay/contracts";
import { ProjectDatabase, withProjectDatabasePublication } from "@relay/storage";
import type { ProjectLocation } from "./location.types";
import { projectMessages } from "./project.messages";

/**
 * Проверяет текущую схему и постоянный ID без миграций/включения WAL; закрывает readonly-соединение.
 * Для живого опубликованного проекта вызывающий передаёт исключительно публичный путь.
 */
export function validateRestorationDatabase(path: string, location: ProjectLocation): void {
  const database = ProjectDatabase.openReadonly(path);
  try {
    if (database.projectId !== location.projectId) {
      throw new RelayError(
        "PROJECT_ID_MISMATCH",
        projectMessages.projectIdMismatch(location.configPath),
        4,
        {
          configPath: location.configPath,
          expected: location.projectId,
          actual: database.projectId,
        },
      );
    }
  } finally {
    database.close();
  }
}

/**
 * Передаёт Storage private staging и синхронную публикацию под SQLite-lock.
 * Занятость сохраняет прежний Runtime-код; остальные причины и файловые эффекты callback не подменяются.
 */
export function withRestorationDatabasePublication(path: string, publish: () => void): void {
  try {
    withProjectDatabasePublication(path, publish);
  } catch (cause) {
    if (!(cause instanceof RelayError && cause.code === "DATABASE_PUBLICATION_BUSY")) {
      throw cause;
    }
    const error = new RelayError("RESTORE_DATABASE_OPEN", projectMessages.restoreDatabaseOpen, 4, {
      path,
    });
    error.cause = cause;
    throw error;
  }
}
