import { join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { readConfig } from "../configuration/config";
import {
  explicitConfig,
  findConfig,
  projectConfigName,
  validateOptions,
} from "../configuration/paths";
import type { ProjectConfig, WorkspaceConfig } from "../configuration/config.types";
import { withFileErrors } from "../configuration/files";
import type { ProjectLocation } from "./location.types";
import { projectMessages } from "./project.messages";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { defaultProjectDatabasePath } from "./database-path";

/**
 * Проверяет наличие, схему и постоянный ID базы выбранного конфига, затем закрывает соединение.
 * Явный databasePath имеет приоритет; без него путь вычисляется из home и projectId.
 * Утраченная база не создаётся заново; несовпадение ID даёт PROJECT_ID_MISMATCH.
 */
export function readProjectLocation(
  path: string,
  config: ProjectConfig,
  options: RuntimeOptions,
): ProjectLocation {
  const databasePath = config.databasePath ?? defaultProjectDatabasePath(options, config.projectId);
  const database = ProjectDatabase.open(databasePath);
  try {
    if (database.projectId !== config.projectId) {
      throw new RelayError("PROJECT_ID_MISMATCH", projectMessages.projectIdMismatch(path), 4, {
        configPath: path,
        expected: config.projectId,
        actual: database.projectId,
      });
    }
    return { projectId: config.projectId, databasePath, configPath: path };
  } finally {
    database.close();
  }
}

/**
 * Выбирает каталог из workspace и читает обязательный relay.config.json в его корне.
 * Стандартное размещение базы использует home исходного вызова, как и прямой выбор проекта.
 * Отсутствующий выбор, неизвестное имя и неверная проектная конфигурация имеют разные диагностики.
 */
function resolveWorkspaceProject(
  config: WorkspaceConfig,
  path: string,
  options: RuntimeOptions,
): ProjectLocation {
  const projectName = options.project;
  if (projectName === undefined) {
    throw new RelayError("PROJECT_REQUIRED", projectMessages.projectRequired, 2, {
      configPath: path,
    });
  }
  const registration = config.projects.find((entry) => entry.name === projectName);
  if (!registration) {
    throw new RelayError("PROJECT_NOT_FOUND", projectMessages.registrationNotFound(projectName), 3);
  }
  const configPath = join(registration.path, projectConfigName);
  const project = readConfig(configPath);
  if ("projects" in project) {
    throw new RelayError(
      "INVALID_CONFIG",
      projectMessages.registrationRequiresProject(configPath),
      2,
    );
  }
  return readProjectLocation(configPath, project, options);
}

/**
 * Разрешает явный конфиг либо проект/workspace только в cwd и проверяет выбранную базу.
 * Без databasePath в проектном конфиге использует стандартный путь внутри options.home.
 * project выбирает workspace в cwd; с явным проектным конфигом он недопустим.
 * Чтение конфигов не создаёт файлов. Проверка базы открывает и закрывает соединение Storage;
 * это проверка на момент выбора, а не удержание снимка до следующего открытия вызывающим.
 */
export function resolveProject(options: RuntimeOptions): ProjectLocation {
  return withFileErrors(() => {
    validateOptions(options);
    const path = explicitConfig(options) ?? findConfig(options.cwd, options.project !== undefined);
    if (!path) {
      throw new RelayError(
        "PROJECT_NOT_FOUND",
        projectMessages.projectNotFound(resolve(options.cwd)),
        3,
      );
    }
    const config = readConfig(path);
    if ("projects" in config) {
      return resolveWorkspaceProject(config, path, options);
    }
    // Явный config определяет источник выбора, но не отменяет --project.
    // Базу нельзя открыть раньше проверки смысла выбора регистрации.
    if (options.project !== undefined) {
      throw new RelayError("WORKSPACE_REQUIRED", projectMessages.workspaceRequired, 2, {
        configPath: path,
      });
    }
    return readProjectLocation(path, config, options);
  });
}
