import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeOptions } from "../configuration/runtime-options.types";

/**
 * Вычисляет стандартный путь SQLite без создания каталогов и чтения конфигурации.
 * Относительный home разрешается от cwd; без home используется homedir()/.relay.
 * projectId уже проверен как отдельное имя каталога либо создан через randomUUID.
 */
export function defaultProjectDatabasePath(options: RuntimeOptions, projectId: string): string {
  const home =
    options.home === undefined ? join(homedir(), ".relay") : resolve(options.cwd, options.home);
  return join(home, "projects", projectId, "project.sqlite");
}
