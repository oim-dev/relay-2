import { dirname, join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { readConfig } from "../configuration/config";
import { explicitConfig, findConfig, projectConfigName } from "../configuration/paths";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { defaultProjectDatabasePath } from "../project/database-path";
import { statusError, statusPath } from "./files";
import { statusMessages as messages } from "./status.messages";
import type { RelayConfigurationStatus, RelayStatusContext } from "./status.types";

/**
 * Только диагностическая подсветка ищет ближайший конфиг в родителях cwd.
 * Это не изменяет правила выбора проекта для обычных предметных команд.
 */
function nearestConfig(options: RuntimeOptions): string | undefined {
  const explicit = explicitConfig(options);
  if (explicit !== undefined) {
    return explicit;
  }
  let directory = resolve(options.cwd);
  for (;;) {
    const path = findConfig(directory, options.project !== undefined);
    if (path !== undefined) {
      return path;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/**
 * Читает отдельный конфиг без открытия БД; ошибка остаётся рядом с исходным путём.
 */
function configuration(path: string, options: RuntimeOptions): RelayConfigurationStatus {
  try {
    const config = readConfig(path);
    const physical = statusPath(path);
    return "projects" in config
      ? {
          path: physical,
          kind: "workspace",
          projectId: null,
          databasePath: null,
          registrations: config.projects,
        }
      : {
          path: physical,
          kind: "project",
          projectId: config.projectId,
          databasePath: statusPath(
            config.databasePath ?? defaultProjectDatabasePath(options, config.projectId),
          ),
          registrations: [],
        };
  } catch (error) {
    return {
      path: resolve(path),
      kind: null,
      projectId: null,
      databasePath: null,
      registrations: [],
      error: statusError(error),
    };
  }
}

/**
 * Собирает известные конфиги из контекста и server scopes; относительные knownPaths разрешаются от cwd.
 * Workspace раскрывается на один уровень:
 * ошибочная регистрация другого workspace не вызывает рекурсивного сканирования диска.
 */
export function readStatusConfigurations(
  options: RuntimeOptions,
  knownPaths: readonly string[],
): { configurations: readonly RelayConfigurationStatus[]; context: RelayStatusContext } {
  const found = new Map<string, RelayConfigurationStatus>();
  /**
   * Читает конфиг один раз и объединяет физические alias; linked означает регистрацию workspace.
   */
  function add(path: string, linked = false): RelayConfigurationStatus {
    const absolute = resolve(options.cwd, path);
    const existing = found.get(absolute);
    if (existing) {
      return existing;
    }
    let value = configuration(absolute, options);
    if (linked && value.kind === "workspace") {
      value = {
        ...value,
        kind: null,
        registrations: [],
        error: { code: "INVALID_CONFIG", message: messages.projectRequired },
      };
    }
    const shared = found.get(value.path);
    found.set(absolute, shared ?? value);
    found.set(value.path, shared ?? value);
    if (!linked && value.kind === "workspace") {
      for (const entry of value.registrations) {
        add(join(entry.path, projectConfigName), true);
      }
    }
    return shared ?? value;
  }
  let context: RelayStatusContext = {
    cwd: resolve(options.cwd),
    configPath: null,
    projectConfigPath: null,
  };
  try {
    const path = nearestConfig(options);
    if (path !== undefined) {
      const selected = add(path);
      context = {
        ...context,
        configPath: selected.path,
        ...(selected.error ? { error: selected.error } : {}),
      };
      if (selected.kind === "project") {
        if (options.project !== undefined) {
          throw new RelayError("WORKSPACE_REQUIRED", messages.workspaceRequired, 2);
        }
        context = { ...context, projectConfigPath: selected.path };
      } else if (selected.kind === "workspace" && options.project !== undefined) {
        const entry = selected.registrations.find((item) => item.name === options.project);
        if (entry === undefined) {
          throw new RelayError("PROJECT_NOT_FOUND", messages.unknownProject, 3);
        }
        const project = add(join(entry.path, projectConfigName), true);
        context = {
          ...context,
          projectConfigPath: project.kind === "project" ? project.path : null,
          ...(project.error ? { error: project.error } : {}),
        };
      }
    } else if (options.project !== undefined) {
      throw new RelayError("WORKSPACE_REQUIRED", messages.workspaceRequired, 2);
    }
  } catch (error) {
    context = { ...context, error: statusError(error) };
  }
  for (const path of knownPaths) {
    add(path);
  }
  return {
    configurations: [...new Set(found.values())].sort((a, b) => a.path.localeCompare(b.path)),
    context,
  };
}
