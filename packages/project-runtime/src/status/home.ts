import { join } from "node:path";
import { resolveRelayHome } from "../configuration/home";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { readStatusConfigurations } from "./configurations";
import { statusPath } from "./files";
import { readStatusProjects } from "./projects";
import type { RelayHomeStatus } from "./status.types";

/**
 * Диагностирует весь RELAY_HOME независимо от cwd; knownConfigs добавляет области серверного реестра.
 * Относительные knownConfigs разрешаются от options.cwd; абсолютные server scopes сохраняются.
 * Контекст и конфиги читаются без открытия БД; каждый кандидат ID/путь проверяется один раз readonly.
 * Не создаёт home, не выполняет миграции, Git, поиск репозиториев по всему диску или предметные записи.
 */
export function inspectRelayHome(
  options: RuntimeOptions,
  knownConfigs: readonly string[] = [],
): RelayHomeStatus {
  const home = statusPath(
    resolveRelayHome({
      cwd: options.cwd,
      ...(options.home === undefined ? {} : { home: options.home }),
    }),
  );
  const { configurations, context } = readStatusConfigurations({ ...options, home }, knownConfigs);
  return {
    home,
    projectsPath: join(home, "projects"),
    serversPath: join(home, "servers"),
    projects: readStatusProjects(home, configurations, context.projectConfigPath),
    configurations,
    context,
  };
}
