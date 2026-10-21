import { dirname, join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { validText } from "./config";
import { configMessages } from "./config.messages";
import { configExists, fileExists } from "./files";
import type { RuntimeOptions } from "./runtime-options.types";

export const projectConfigName = join(".relay", "config.json");
export const workspaceConfigName = "relay.workspace.json";

/**
 * Проверяет переданный локальный контекст до любых файловых операций.
 * cwd обязателен; пустые явно заданные значения остальных полей также недопустимы.
 */
export function validateOptions(options: RuntimeOptions): void {
  for (const key of ["cwd", "home", "config", "project"] as const) {
    const value = options[key];
    if ((key === "cwd" || value !== undefined) && !validText(value)) {
      throw new RelayError("INVALID_ARGUMENT", configMessages.emptyOption(key), 2);
    }
  }
}

/**
 * Разрешает явный конфиг от cwd; undefined сохраняет выбор через поиск предков.
 */
export function explicitConfig(options: RuntimeOptions): string | undefined {
  if (options.config === undefined) {
    return undefined;
  }
  return resolve(options.cwd, options.config);
}

/**
 * Перечисляет лексические абсолютные каталоги от cwd до корня включительно.
 * Существование cwd не требуется; физические ссылки разрешаются позже при чтении конфига.
 */
function* ancestors(cwd: string): Generator<string, void, undefined> {
  let directory = resolve(cwd);
  for (;;) {
    yield directory;
    const parent = dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}

/**
 * Находит ближайший конфиг, не пропуская повреждённый файл или битую ссылку.
 * В одном каталоге проект имеет приоритет; workspaceOnly исключает проектные конфиги.
 */
export function findConfig(cwd: string, workspaceOnly: boolean): string | undefined {
  for (const directory of ancestors(cwd)) {
    if (!workspaceOnly) {
      const project = join(directory, projectConfigName);
      if (fileExists(project)) {
        return project;
      }
    }
    const workspace = join(directory, workspaceConfigName);
    if (fileExists(workspace)) {
      return workspace;
    }
  }
  return undefined;
}

/**
 * Выбирает свободный путь начальной публикации, не создавая каталогов.
 * Неявный init не создаёт вложенный проект внутри проекта; внутри workspace проект допустим.
 * Явный config обходит поиск предков, но никогда не разрешает замену существующего пути.
 */
export function initializationPath(options: RuntimeOptions, workspace: boolean): string {
  validateOptions(options);
  if (options.project !== undefined) {
    throw new RelayError("INVALID_ARGUMENT", configMessages.initializationProjectSelection, 2);
  }
  const explicit = explicitConfig(options);
  const path =
    explicit ?? resolve(options.cwd, workspace ? workspaceConfigName : projectConfigName);
  if (fileExists(path)) {
    throw configExists(path);
  }

  if (explicit === undefined) {
    for (const directory of ancestors(options.cwd)) {
      const project = join(directory, projectConfigName);
      if (fileExists(project)) {
        throw configExists(project);
      }
      const existingWorkspace = join(directory, workspaceConfigName);
      if (fileExists(existingWorkspace)) {
        if (directory === resolve(options.cwd) || workspace) {
          throw configExists(existingWorkspace);
        }
        break;
      }
    }
  }
  return path;
}
