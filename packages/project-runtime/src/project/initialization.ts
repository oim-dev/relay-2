import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { ProjectDatabase } from "@relay/storage";
import { initializationPath } from "../configuration/paths";
import { withFileErrors, writeJsonAtomic } from "../configuration/files";
import type { InitializeProjectOptions } from "./initialization.types";
import { projectName, projectSlug } from "./input";
import type { ProjectLocation } from "./location.types";
import { defaultProjectDatabasePath } from "./database-path";

/**
 * Создаёт независимую SQLite и эксклюзивно публикует конфиг после успешного создания базы.
 * Каждый вызов владеет новым каталогом постоянного ID; отказ, включая проигранную гонку
 * публикации, удаляет только этот каталог. Существующие конфиги не изменяются.
 * Значение RELAY_HOME передаётся в options.home: Runtime не читает окружение процесса.
 * Конфиг сохраняет только version и projectId; путь базы вычисляется из home при каждом выборе.
 */
export function initializeProject(options: InitializeProjectOptions): ProjectLocation {
  return withFileErrors(() => {
    const configPath = initializationPath(options, false);
    const name = projectName(options);
    const projectId = randomUUID();
    const slug = projectSlug(name, projectId, options.slug);
    const databasePath = defaultProjectDatabasePath(options, projectId);
    const projectDirectory = dirname(databasePath);

    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(dirname(projectDirectory), { recursive: true });
    mkdirSync(projectDirectory, { mode: 0o700 });
    try {
      const database = ProjectDatabase.create(databasePath, { id: projectId, name, slug });
      database.close();
      writeJsonAtomic(configPath, { version: 1, projectId }, "create");
    } catch (error) {
      // Каталог принадлежит только этой попытке init; победивший проект не затрагивается.
      rmSync(projectDirectory, { recursive: true, force: true });
      throw error;
    }
    return { projectId, databasePath, configPath };
  });
}
