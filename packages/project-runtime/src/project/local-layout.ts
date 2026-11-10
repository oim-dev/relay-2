import { writeJsonAtomic } from "../configuration/files";
import type { ProjectLocation } from "./location.types";

/**
 * Эксклюзивно публикует переносимый ID проекта без привязки к checkout или домашнему каталогу.
 * SQLite и служебное состояние выбираются из home вызывающего по этому ID.
 */
export function publishProjectLocation(location: ProjectLocation): void {
  writeJsonAtomic(location.configPath, { version: 1, projectId: location.projectId }, "create");
}
