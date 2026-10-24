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
import type { OpenedProject, ProjectLocation } from "./location.types";
import type { SelectedProjectConfig } from "./selection.types";
import { projectMessages } from "./project.messages";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { defaultProjectDatabasePath } from "./database-path";

/**
 * Открывает базу проверенного конфига и передаёт соединение только после сверки постоянного ID.
 * Явный databasePath имеет приоритет; без него путь вычисляется из home и projectId.
 * Утраченная база не создаётся заново; при любой ошибке после открытия соединение закрывается.
 */
function openProjectLocation(
  path: string,
  config: ProjectConfig,
  options: RuntimeOptions,
): OpenedProject {
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
    return {
      location: { projectId: config.projectId, databasePath, configPath: path },
      database,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Проверяет наличие, схему и постоянный ID базы выбранного конфига, затем закрывает соединение.
 * Возвращаемое расположение не удерживает снимок для последующего открытия вызывающим.
 */
export function readProjectLocation(
  path: string,
  config: ProjectConfig,
  options: RuntimeOptions,
): ProjectLocation {
  const project = openProjectLocation(path, config, options);
  try {
    return project.location;
  } finally {
    project.database.close();
  }
}

/**
 * Выбирает каталог из workspace и читает обязательный relay.config.json в его корне.
 * Возвращает конфигурацию без открытия базы; путь внутри неё разрешает общий читатель конфигов.
 * Отсутствующий выбор, неизвестное имя и неверная проектная конфигурация имеют разные диагностики.
 */
function resolveWorkspaceProject(
  config: WorkspaceConfig,
  path: string,
  options: RuntimeOptions,
): SelectedProjectConfig {
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
  return { configPath, config: project };
}

/**
 * Выбирает проверенный проектный конфиг по единым правилам cwd, явного пути и workspace.
 * Параметры проверяются до чтения файлов; базы ещё не открываются. Частичный выбор наружу не выходит.
 */
export function selectProjectConfig(options: RuntimeOptions): SelectedProjectConfig {
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
  return { configPath: path, config };
}

/**
 * Выбирает проект и открывает его базу один раз, проверяя совместимость и соответствие ID конфигу.
 * Возвращает рабочее соединение во владение вызывающего: тот обязан закрыть database в finally.
 * Снимок и транзакция не удерживаются автоматически. При отказе новое соединение закрывается.
 * Выбор конфигов, workspace и путей совпадает с resolveProject; отсутствующая база не создаётся.
 */
export function openProject(options: RuntimeOptions): OpenedProject {
  return withFileErrors(() => {
    const { configPath, config } = selectProjectConfig(options);
    return openProjectLocation(configPath, config, options);
  });
}

/**
 * Разрешает явный конфиг либо проект/workspace только в cwd и проверяет выбранную базу.
 * Без databasePath использует стандартное размещение внутри options.home.
 * Проверочное соединение закрывается; результат не удерживает снимок до следующего открытия.
 * Для сценария с одним рабочим соединением используйте openProject с явным владением ресурсом.
 */
export function resolveProject(options: RuntimeOptions): ProjectLocation {
  return withFileErrors(() => {
    const { configPath, config } = selectProjectConfig(options);
    return readProjectLocation(configPath, config, options);
  });
}
