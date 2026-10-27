import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { RelayError } from "@relay/contracts";
import { validText } from "./config";
import { configMessages } from "./config.messages";
import { configExists, fileExists } from "./files";
import { fileMessages } from "./files.messages";
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
 * Разрешает каталог Linux, сохраняя порядок symlink и последующих `..` в цели файловой ссылки.
 * Обычный путь требует один realpath; родитель выбирается уже от физического каталога.
 */
function physicalDirectory(path: string): string {
  const segments = path.split("/");
  if (!segments.includes("..")) {
    return realpathSync(path);
  }
  const directory = physicalDirectory(dirname(path));
  const name = basename(path);
  return name === ".." ? dirname(directory) : realpathSync(join(directory, name));
}

/**
 * Разрешает физическое имя существующего конфига для публикации и общего mutex.
 * В Linux realpath применяется только к каталогу, конечные symlink раскрываются через readlink:
 * замена inode не подставляет имя удалённого файла. Остальные ОС сохраняют полный realpath,
 * включая канонизацию коротких имён Windows. Каталоги и ссылки этот вызов не заменяет.
 * Цикл ссылок возвращает файловую ошибку ELOOP; остальные отказы ФС передаются вызывающему.
 */
export function physicalConfigPath(path: string): string {
  if (process.platform !== "linux") {
    return realpathSync(path);
  }
  const links = new Set<string>();
  let current = path;
  for (;;) {
    const directory = physicalDirectory(dirname(current));
    const file = join(directory, basename(current));
    if (!lstatSync(file).isSymbolicLink()) {
      return file;
    }
    if (links.has(file)) {
      throw Object.assign(new Error(fileMessages.symbolicLinkCycle(path)), {
        code: "ELOOP",
        syscall: "readlink",
        path,
      });
    }
    links.add(file);
    const target = readlinkSync(file);
    // Сохраняем компоненты цели до физического разрешения каталога, включая symlink перед `..`.
    current = isAbsolute(target) ? target : `${directory}${sep}${target}`;
  }
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
