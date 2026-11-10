import { join } from "node:path";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { resolveRelayHome } from "../configuration/home";

/**
 * Вычисляет стандартный путь SQLite без создания каталогов и чтения конфигурации.
 * Относительный home разрешается от cwd; без home используется homedir()/.relay.
 * projectId уже проверен как отдельное имя каталога либо создан через randomUUID.
 */
export function defaultProjectDatabasePath(options: RuntimeOptions, projectId: string): string {
  return join(resolveRelayHome(options), "projects", projectId, "project.sqlite");
}
