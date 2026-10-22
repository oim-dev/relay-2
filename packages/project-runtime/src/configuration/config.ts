import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { configMessages } from "./config.messages";
import type { ProjectConfig, ProjectRegistration, WorkspaceConfig } from "./config.types";
import { hasCode } from "./files";

/**
 * Проверяет непустую строку конфигурации или пути без нулевого символа.
 */
export function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

/**
 * Проверяет единое правило имени регистрации для файла workspace и команд его изменения.
 */
export function validRegistrationName(value: unknown): value is string {
  return validText(value) && value === value.trim();
}

/**
 * Сужает неизвестное JSON-значение до объекта для последующей проверки полей.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Создаёт одинаковую диагностику повреждённого формата с путём исходного конфига.
 */
function invalidConfig(path: string): RelayError {
  return new RelayError("INVALID_CONFIG", configMessages.invalidConfig(path), 2, { path });
}

/**
 * Декодирует JSON без изменения схемы и без подмены повреждённых данных пустым объектом.
 */
function parseConfig(text: string, path: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalidConfig(path);
  }
  if (!isObject(data) || data.version !== 1) {
    throw invalidConfig(path);
  }
  return data;
}

/**
 * Декодирует регистрации одного снимка и разрешает пути каталогов от workspace.
 * Повторы имён, записи без path и со старым configPath отклоняются; проекты здесь не открываются.
 */
function readRegistrations(
  entries: readonly unknown[],
  directory: string,
  path: string,
): ProjectRegistration[] {
  const names = new Set<string>();
  const projects: ProjectRegistration[] = [];
  for (const entry of entries) {
    if (
      !isObject(entry) ||
      !validRegistrationName(entry.name) ||
      "configPath" in entry ||
      !validText(entry.path) ||
      names.has(entry.name)
    ) {
      throw invalidConfig(path);
    }
    names.add(entry.name);
    projects.push({ name: entry.name, path: resolve(directory, entry.path) });
  }
  return projects;
}

/**
 * Читает один целый JSON и проверяет локальный формат без открытия базы проекта.
 * Явные относительные пути разрешаются от физического каталога файла, включая symlink.
 * Отсутствующий databasePath сохраняется: стандартное размещение вычисляет выбор проекта.
 * Без явного пути projectId должен быть одним именем каталога, отличным от `.` и `..`.
 * Отсутствие файла даёт CONFIG_NOT_FOUND, неверная схема или тип компонента пути — INVALID_CONFIG.
 */
export function readConfig(path: string): ProjectConfig | WorkspaceConfig {
  let text: string;
  let directory: string;
  try {
    text = readFileSync(path, "utf8");
    directory = dirname(realpathSync(path));
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw new RelayError("CONFIG_NOT_FOUND", configMessages.configNotFound(path), 3, { path });
    }
    if (hasCode(error, "EISDIR") || hasCode(error, "ENOTDIR")) {
      throw invalidConfig(path);
    }
    throw error;
  }

  const data = parseConfig(text, path);
  if ("projectId" in data || "databasePath" in data) {
    const databasePath = data.databasePath;
    if (
      !validText(data.projectId) ||
      (databasePath !== undefined && !validText(databasePath)) ||
      "projects" in data
    ) {
      throw invalidConfig(path);
    }
    if (
      databasePath === undefined &&
      (data.projectId === "." || data.projectId === ".." || /[/\\]/u.test(data.projectId))
    ) {
      throw invalidConfig(path);
    }
    return {
      version: 1,
      projectId: data.projectId,
      ...(databasePath === undefined ? {} : { databasePath: resolve(directory, databasePath) }),
    };
  }

  if (!Array.isArray(data.projects)) {
    throw invalidConfig(path);
  }
  return { version: 1, projects: readRegistrations(data.projects, directory, path) };
}

/**
 * Читает снимок реестра; проектный конфиг отклоняется с WORKSPACE_REQUIRED.
 * Недоступность зарегистрированных проектов не мешает чтению и последующему удалению ссылок.
 */
export function readWorkspace(path: string): WorkspaceConfig {
  const config = readConfig(path);
  if (!("projects" in config)) {
    throw new RelayError("WORKSPACE_REQUIRED", configMessages.workspaceExpected(path), 2, {
      path,
    });
  }
  return config;
}
