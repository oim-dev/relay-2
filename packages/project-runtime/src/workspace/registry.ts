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
import { physicalConfigPath } from "../native/config-path/select";
import { withFileErrors, withWorkspaceLock, writeJsonAtomic } from "../configuration/files";
import { readProjectLocation } from "../project/selection";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { workspaceMessages } from "./registry.messages";
import type { ProjectRegistration } from "../configuration/config.types";
import type { WorkspaceLocation, WorkspaceSnapshot } from "./registry.types";

/**
 * Проверяет имя регистрации до чтения или изменения реестра.
 */
function validateRegistrationName(name: string): void {
  if (!validRegistrationName(name)) {
    throw new RelayError("INVALID_ARGUMENT", workspaceMessages.invalidRegistrationName, 2);
  }
}

/**
 * Находит workspace и однократно читает проверенный снимок вместе с физическим путём.
 * Разные символьные ссылки на один файл обязаны конкурировать за одну блокировку.
 * Снимок пригоден для чтения; мутации перечитывают актуальный реестр уже под mutex.
 */
function readSelectedWorkspace(options: RuntimeOptions): WorkspaceSnapshot {
  validateOptions(options);
  const path = explicitConfig(options) ?? findConfig(options.cwd, true);
  if (!path) {
    throw new RelayError(
      "WORKSPACE_NOT_FOUND",
      workspaceMessages.workspaceNotFound(resolve(options.cwd)),
      3,
    );
  }
  const config = readWorkspace(path);
  return { configPath: physicalConfigPath(path), config };
}

/**
 * Читает обязательный relay.config.json в регистрируемом каталоге и проверяет его базу.
 * Без явного пути базы использует home регистрирующего вызова, разрешённый от его cwd.
 * Существующий объект другого типа даёт INVALID_CONFIG до чтения вложенного пути.
 * Возвращает физический путь каталога. Workspace вместо проекта отклоняется без записи.
 */
function registrationDirectory(options: RuntimeOptions, path: string): string {
  if (!validText(path)) {
    throw new RelayError("INVALID_ARGUMENT", workspaceMessages.emptyProjectPath, 2);
  }
  const directory = resolve(options.cwd, path);
  // Windows может вернуть ENOENT вместо ENOTDIR для file/relay.config.json.
  // Проверяем сам переданный путь, чтобы тип существующего объекта не зависел от ОС.
  if (statSync(directory, { throwIfNoEntry: false })?.isDirectory() === false) {
    throw new RelayError(
      "INVALID_CONFIG",
      workspaceMessages.projectDirectoryRequired(directory),
      2,
      { path: directory },
    );
  }
  const configPath = join(directory, projectConfigName);
  const config = readConfig(configPath);
  if ("projects" in config) {
    throw new RelayError(
      "INVALID_CONFIG",
      workspaceMessages.cannotRegisterWorkspace(configPath),
      2,
    );
  }
  readProjectLocation(configPath, config, options);
  return realpathSync(directory);
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
 * Читает и декодирует полный реестр ровно один раз за вызов.
 * Не открывает конфиги и базы зарегистрированных проектов, поэтому недоступные ссылки видны.
 */
export function listProjects(options: RuntimeOptions): ProjectRegistration[] {
  return withFileErrors(() => readSelectedWorkspace(options).config.projects);
}

/**
 * Проверяет целевой проект и добавляет физический путь его каталога под mutex workspace.
 * Чтение текущего реестра, проверка имени и атомарная замена файла входят в одну секцию.
 * То же имя с тем же путём — no-op; другой путь даёт PROJECT_EXISTS без записи.
 */
export function registerProject(options: RuntimeOptions, name: string, path: string): void {
  withFileErrors(() => {
    validateRegistrationName(name);
    const workspace = readSelectedWorkspace(options).configPath;
    const directory = registrationDirectory(options, path);

    withWorkspaceLock(workspace, () => {
      const current = readWorkspace(workspace);
      const existing = current.projects.find((entry) => entry.name === name);
      if (existing) {
        if (existing.path === directory) {
          return;
        }
        throw new RelayError("PROJECT_EXISTS", workspaceMessages.registrationExists(name), 4);
      }
      current.projects.push({ name, path: directory });
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
    const workspace = readSelectedWorkspace(options).configPath;
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
