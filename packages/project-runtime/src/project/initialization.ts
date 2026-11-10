import { randomUUID } from "node:crypto";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { initializationPath } from "../configuration/paths";
import { configExists, fileExists, withFileErrors } from "../configuration/files";
import type { InitializeProjectOptions } from "./initialization.types";
import { projectName, projectSlug } from "./input";
import type { ProjectLocation } from "./location.types";
import { restoreProject } from "./restoration";

/**
 * Создаёт независимую SQLite и эксклюзивно публикует конфиг после успешного создания базы.
 * Общий механизм публикации сериализует писателей в home/projects/<ID> и владеет private staging,
 * а не всем общим каталогом. До публикации отказ убирает только staging; после неё
 * сохранённая БД/intent доступны через resume, включая поздние записи других участников.
 * Проигрыш другому завершённому init даёт CONFIG_EXISTS без удаления его файлов.
 * Значение RELAY_HOME передаётся в options.home: Runtime не читает окружение процесса.
 * Конфиг сохраняет только ID; home определяет расположение всей локальной реплики.
 */
export function initializeProject(options: InitializeProjectOptions): ProjectLocation {
  return withFileErrors(() => {
    const configPath = initializationPath(options, false);
    const name = projectName(options);
    const projectId = randomUUID();
    const slug = projectSlug(name, projectId, options.slug);
    try {
      return restoreProject(options, projectId, (path) => {
        ProjectDatabase.create(path, { id: projectId, name, slug }).close();
      });
    } catch (error) {
      if (
        error instanceof RelayError &&
        (error.code === "DATABASE_EXISTS" || error.code === "PROJECT_ID_MISMATCH") &&
        fileExists(configPath)
      ) {
        throw configExists(configPath);
      }
      throw error;
    }
  });
}
