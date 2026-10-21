import { join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { validText } from "./config";
import { configMessages } from "./config.messages";
import { configExists, fileExists } from "./files";
import type { RuntimeOptions } from "./runtime-options.types";

export const projectConfigName = "relay.config.json";
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
 * Разрешает явный конфиг от cwd; undefined сохраняет выбор конфигурации в самом cwd.
 */
export function explicitConfig(options: RuntimeOptions): string | undefined {
  if (options.config === undefined) {
    return undefined;
  }
  return resolve(options.cwd, options.config);
}

/**
 * Ищет конфиг только в cwd, включая повреждённый файл или битую ссылку.
 * Проект имеет приоритет; workspaceOnly исключает проектный конфиг. Родители не проверяются.
 */
export function findConfig(cwd: string, workspaceOnly: boolean): string | undefined {
  const directory = resolve(cwd);
  if (!workspaceOnly) {
    const project = join(directory, projectConfigName);
    if (fileExists(project)) {
      return project;
    }
  }
  const workspace = join(directory, workspaceConfigName);
  return fileExists(workspace) ? workspace : undefined;
}

/**
 * Выбирает свободный путь начальной публикации, не создавая каталогов.
 * Неявный init проверяет оба стандартных конфига только в cwd; вложенные проекты независимы.
 * Явный config проверяет только переданный путь. Занятый путь никогда не заменяется.
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
    const other = resolve(options.cwd, workspace ? projectConfigName : workspaceConfigName);
    if (fileExists(other)) {
      throw configExists(other);
    }
  }
  return path;
}
