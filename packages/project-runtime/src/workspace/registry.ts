import { mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import {
  readConfig,
  readWorkspace,
  validRegistrationName,
  validText,
} from "../configuration/config";
import {
  explicitConfig,
  findConfig,
  initializationPath,
  projectConfigName,
  validateOptions,
} from "../configuration/paths";
import {
  fileExists,
  withFileErrors,
  withWorkspaceLock,
  writeJsonAtomic,
} from "../configuration/files";
import { readProjectLocation } from "../project/selection";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { workspaceMessages } from "./registry.messages";
import type { ProjectRegistration } from "../configuration/config.types";
import type { WorkspaceLocation } from "./registry.types";

/**
 * Проверяет имя регистрации до чтения или изменения реестра.
 */
function validateRegistrationName(name: string): void {
  if (!validRegistrationName(name)) {
    throw new RelayError("INVALID_ARGUMENT", workspaceMessages.invalidRegistrationName, 2);
  }
}

/**
 * Находит и проверяет workspace, затем возвращает физический путь для общего mutex.
 * Разные символьные ссылки на один файл обязаны конкурировать за одну блокировку.
 */
function workspacePath(options: RuntimeOptions): string {
  validateOptions(options);
  const path = explicitConfig(options) ?? findConfig(options.cwd, true);
  if (!path) {
    throw new RelayError(
      "WORKSPACE_NOT_FOUND",
      workspaceMessages.workspaceNotFound(resolve(options.cwd)),
      3,
    );
  }
  readWorkspace(path);
  return realpathSync(path);
}

/**
 * Проверяет регистрируемый каталог или конфиг вместе с базой и возвращает физический путь.
 * Workspace вместо проекта отклоняется; сама регистрация здесь ещё не изменяется.
 */
function registrationConfigPath(cwd: string, path: string): string {
  if (!validText(path)) {
    throw new RelayError("INVALID_ARGUMENT", workspaceMessages.emptyProjectPath, 2);
  }
  let configPath = resolve(cwd, path);
  if (fileExists(configPath) && statSync(configPath).isDirectory()) {
    configPath = join(configPath, projectConfigName);
  }
  const config = readConfig(configPath);
  if ("projects" in config) {
    throw new RelayError(
      "INVALID_CONFIG",
      workspaceMessages.cannotRegisterWorkspace(configPath),
      2,
    );
  }
  readProjectLocation(configPath, config);
  return realpathSync(configPath);
}

/**
 * Эксклюзивно публикует пустой workspace, создавая недостающие родительские каталоги.
 * Существующая конфигурация и проигранная гонка публикации дают CONFIG_EXISTS без замены файла.
 */
export function initializeWorkspace(options: RuntimeOptions): WorkspaceLocation {
  return withFileErrors(() => {
    const configPath = initializationPath(options, true);
    mkdirSync(dirname(configPath), { recursive: true });
    writeJsonAtomic(configPath, { version: 1, projects: [] }, "create");
    return { configPath };
  });
}

/**
 * Возвращает весь список регистраций из одного целого снимка workspace в порядке добавления.
 * Не открывает конфиги и базы зарегистрированных проектов, поэтому недоступные ссылки видны.
 */
export function listProjects(options: RuntimeOptions): ProjectRegistration[] {
  return withFileErrors(() => readWorkspace(workspacePath(options)).projects);
}

/**
 * Проверяет целевой проект и добавляет его физический путь под межпроцессным mutex workspace.
 * Чтение текущего реестра, проверка имени и атомарная замена файла входят в одну секцию.
 * То же имя с тем же путём — no-op; другой путь даёт PROJECT_EXISTS без записи.
 */
export function registerProject(options: RuntimeOptions, name: string, path: string): void {
  withFileErrors(() => {
    validateRegistrationName(name);
    const workspace = workspacePath(options);
    const configPath = registrationConfigPath(options.cwd, path);

    withWorkspaceLock(workspace, () => {
      const current = readWorkspace(workspace);
      const existing = current.projects.find((entry) => entry.name === name);
      if (existing) {
        if (existing.configPath === configPath) {
          return;
        }
        throw new RelayError("PROJECT_EXISTS", workspaceMessages.registrationExists(name), 4);
      }
      current.projects.push({ name, configPath });
      writeJsonAtomic(workspace, current, "replace");
    });
  });
}

/**
 * Удаляет только регистрацию, сохраняя конфиг, SQLite и данные самого проекта.
 * Чтение и атомарная замена реестра выполняются под одним mutex; отсутствующее имя
 * возвращает false без замены JSON, но файл блокировки может быть создан.
 */
export function unregisterProject(options: RuntimeOptions, name: string): boolean {
  return withFileErrors(() => {
    validateRegistrationName(name);
    const workspace = workspacePath(options);
    return withWorkspaceLock(workspace, () => {
      const current = readWorkspace(workspace);
      const index = current.projects.findIndex((entry) => entry.name === name);
      if (index < 0) {
        return false;
      }
      current.projects.splice(index, 1);
      writeJsonAtomic(workspace, current, "replace");
      return true;
    });
  });
}
