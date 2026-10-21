import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ProjectDatabase } from "@relay/storage";
import { initializationPath } from "../configuration/paths";
import { withFileErrors, writeJsonAtomic } from "../configuration/files";
import type { InitializeProjectOptions } from "./initialization.types";
import { projectName, projectSlug } from "./input";
import type { ProjectLocation } from "./location.types";

/**
 * Создаёт независимую SQLite и эксклюзивно публикует конфиг после успешного создания базы.
 * Каждый вызов владеет новым каталогом постоянного ID; отказ, включая проигранную гонку
 * публикации, удаляет только этот каталог. Существующие конфиги не изменяются.
 * Значение RELAY_HOME передаётся в options.home: Runtime не читает окружение процесса.
 */
export function initializeProject(options: InitializeProjectOptions): ProjectLocation {
  return withFileErrors(() => {
    const configPath = initializationPath(options, false);
    const name = projectName(options);
    const projectId = randomUUID();
    const slug = projectSlug(name, projectId, options.slug);
    const home =
      options.home === undefined ? join(homedir(), ".relay") : resolve(options.cwd, options.home);
    const projectDirectory = join(home, "projects", projectId);
    const databasePath = join(projectDirectory, "project.sqlite");

    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(dirname(projectDirectory), { recursive: true });
    mkdirSync(projectDirectory, { mode: 0o700 });
    try {
      const database = ProjectDatabase.create(databasePath, { id: projectId, name, slug });
      database.close();
      writeJsonAtomic(configPath, { version: 1, projectId, databasePath }, "create");
    } catch (error) {
      // Каталог принадлежит только этой попытке init; победивший проект не затрагивается.
      rmSync(projectDirectory, { recursive: true, force: true });
      throw error;
    }
    return { projectId, databasePath, configPath };
  });
}
