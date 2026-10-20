import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import {
  ancestors,
  findConfig,
  projectConfigName,
  readConfig,
  readWorkspace,
  validText,
  workspaceConfigName,
} from "./config";
import type { ProjectConfig } from "./config";
import {
  configExists,
  fileExists,
  withFileErrors,
  withWorkspaceLock,
  writeJsonAtomic,
} from "./files";
import type { ProjectLocation, RuntimeOptions } from "./types";

function validateOptions(options: RuntimeOptions): void {
  for (const key of ["cwd", "home", "config", "project"] as const) {
    const value = options[key];
    if ((key === "cwd" || value !== undefined) && !validText(value)) {
      throw new RelayError("INVALID_ARGUMENT", `Параметр ${key} не должен быть пустым`, 2);
    }
  }
}

function validateName(name: string): void {
  if (!validText(name) || name !== name.trim()) {
    throw new RelayError(
      "INVALID_ARGUMENT",
      "Имя регистрации не должно быть пустым или содержать пробелы по краям",
      2,
    );
  }
}

function explicitConfig(options: RuntimeOptions): string | undefined {
  return options.config === undefined ? undefined : resolve(options.cwd, options.config);
}

function projectLocation(path: string, config: ProjectConfig): ProjectLocation {
  // Открытие через Storage проверяет наличие и схему БД, не создавая пустой
  // проект вместо утраченных данных. Конфиг не может перенаправить чужой ID.
  const database = ProjectDatabase.open(config.databasePath);
  try {
    if (database.projectId !== config.projectId) {
      throw new RelayError(
        "PROJECT_ID_MISMATCH",
        `ID проекта в конфигурации и базе не совпадают: ${path}`,
        4,
        {
          configPath: path,
          expected: config.projectId,
          actual: database.projectId,
        },
      );
    }
    return { projectId: config.projectId, databasePath: config.databasePath, configPath: path };
  } finally {
    database.close();
  }
}

function workspacePath(options: RuntimeOptions): string {
  validateOptions(options);
  const path = explicitConfig(options) ?? findConfig(options.cwd, true);
  if (!path) {
    throw new RelayError("WORKSPACE_NOT_FOUND", `Workspace не найден: ${resolve(options.cwd)}`, 3);
  }
  readWorkspace(path);
  // Разные символьные ссылки на один workspace должны использовать один замок.
  return realpathSync(path);
}

export function resolveProject(options: RuntimeOptions): ProjectLocation {
  return withFileErrors(() => {
    validateOptions(options);
    const path = explicitConfig(options) ?? findConfig(options.cwd, options.project !== undefined);
    if (!path) {
      throw new RelayError("PROJECT_NOT_FOUND", `Проект не найден: ${resolve(options.cwd)}`, 3);
    }
    const config = readConfig(path);
    if (!("projects" in config)) {
      // Явный config определяет источник выбора, но не отменяет --project.
      // Не открываем чужую базу, если источник не содержит регистраций.
      if (options.project !== undefined) {
        throw new RelayError(
          "WORKSPACE_REQUIRED",
          "Выбор --project требует конфигурацию workspace",
          2,
          { configPath: path },
        );
      }
      return projectLocation(path, config);
    }
    if (options.project === undefined) {
      throw new RelayError("PROJECT_REQUIRED", "Выберите проект workspace через --project", 2, {
        configPath: path,
      });
    }
    const registration = config.projects.find((entry) => entry.name === options.project);
    if (!registration) {
      throw new RelayError(
        "PROJECT_NOT_FOUND",
        `Проект не зарегистрирован в workspace: ${options.project}`,
        3,
      );
    }
    const project = readConfig(registration.configPath);
    if ("projects" in project) {
      throw new RelayError(
        "INVALID_CONFIG",
        `Регистрация должна ссылаться на проект: ${registration.configPath}`,
        2,
      );
    }
    return projectLocation(registration.configPath, project);
  });
}

function initializationPath(options: RuntimeOptions, workspace: boolean): string {
  validateOptions(options);
  if (options.project !== undefined) {
    throw new RelayError(
      "INVALID_ARGUMENT",
      "При инициализации нельзя выбирать регистрацию --project",
      2,
    );
  }
  const explicit = explicitConfig(options);
  const path =
    explicit ?? resolve(options.cwd, workspace ? workspaceConfigName : projectConfigName);
  if (fileExists(path)) throw configExists(path);

  if (explicit === undefined) {
    for (const directory of ancestors(options.cwd)) {
      const project = join(directory, projectConfigName);
      if (fileExists(project)) throw configExists(project);
      const existingWorkspace = join(directory, workspaceConfigName);
      if (fileExists(existingWorkspace)) {
        // Внутри workspace допустимы независимые проекты. Внутри уже
        // выбранного проекта случайный повтор init не создаёт вложенную БД.
        if (directory === resolve(options.cwd) || workspace) throw configExists(existingWorkspace);
        break;
      }
    }
  }
  return path;
}

export function initializeProject(
  options: RuntimeOptions & { name?: string; slug?: string },
): ProjectLocation {
  return withFileErrors(() => {
    const configPath = initializationPath(options, false);
    const rawName = options.name ?? (basename(resolve(options.cwd)) || "Проект");
    if (!validText(rawName)) {
      throw new RelayError("INVALID_ARGUMENT", "Название проекта не должно быть пустым", 2);
    }
    const name = rawName.trim();
    if (name.length > 120 || /[\p{Cc}\u2028\u2029]/u.test(name)) {
      throw new RelayError(
        "INVALID_ARGUMENT",
        "Название проекта: 1–120 символов однострочного текста без управляющих символов",
        2,
      );
    }
    const projectId = randomUUID();
    const derivedSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    // Slug — адрес, а не отображаемое имя. Для имени без подходящего
    // латинского адреса используем ID; явный пользовательский slug не исправляем.
    const slug =
      options.slug ??
      (validProjectSlug(derivedSlug) ? derivedSlug : `project-${projectId.slice(0, 8)}`);
    if (!validProjectSlug(slug)) {
      throw new RelayError(
        "INVALID_ARGUMENT",
        "Slug проекта: 2–64 строчные латинские буквы/цифры с одиночными дефисами между частями",
        2,
      );
    }
    // Значение RELAY_HOME передаёт вызывающая CLI. Runtime не читает и не
    // меняет окружение процесса, поэтому несколько контекстов изолированы.
    const home =
      options.home === undefined ? join(homedir(), ".relay") : resolve(options.cwd, options.home);
    const projectDirectory = join(home, "projects", projectId);
    const databasePath = join(projectDirectory, "project.sqlite");
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(dirname(projectDirectory), { recursive: true });
    mkdirSync(projectDirectory, { mode: 0o700 });
    try {
      const database = ProjectDatabase.create(databasePath, { id: projectId, name, slug });
      database.close();
      writeJsonAtomic(configPath, { version: 1, projectId, databasePath }, true);
    } catch (error) {
      // Каталог принадлежит только этой попытке init. При проигранной
      // конкурентной публикации нельзя оставить бесхозную базу.
      rmSync(projectDirectory, { recursive: true, force: true });
      throw error;
    }
    return { projectId, databasePath, configPath };
  });
}

function validProjectSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 64 &&
    value === value.trim() &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  );
}

export function initializeWorkspace(options: RuntimeOptions): { configPath: string } {
  return withFileErrors(() => {
    const configPath = initializationPath(options, true);
    mkdirSync(dirname(configPath), { recursive: true });
    writeJsonAtomic(configPath, { version: 1, projects: [] }, true);
    return { configPath };
  });
}

export function listProjects(options: RuntimeOptions): Array<{ name: string; configPath: string }> {
  return withFileErrors(() => {
    // Даже повреждённую регистрацию можно перечислить и затем удалить.
    return readWorkspace(workspacePath(options)).projects;
  });
}

export function registerProject(options: RuntimeOptions, name: string, path: string): void {
  withFileErrors(() => {
    validateName(name);
    const workspace = workspacePath(options);
    if (!validText(path))
      throw new RelayError("INVALID_ARGUMENT", "Путь проекта не должен быть пустым", 2);
    let configPath = resolve(options.cwd, path);
    if (fileExists(configPath) && statSync(configPath).isDirectory()) {
      configPath = join(configPath, projectConfigName);
    }
    const config = readConfig(configPath);
    if ("projects" in config) {
      throw new RelayError(
        "INVALID_CONFIG",
        `Нельзя зарегистрировать workspace вместо проекта: ${configPath}`,
        2,
      );
    }
    projectLocation(configPath, config);
    configPath = realpathSync(configPath);

    withWorkspaceLock(workspace, () => {
      const current = readWorkspace(workspace);
      const existing = current.projects.find((entry) => entry.name === name);
      if (existing) {
        if (existing.configPath === configPath) return;
        throw new RelayError("PROJECT_EXISTS", `Имя проекта уже зарегистрировано: ${name}`, 4);
      }
      current.projects.push({ name, configPath });
      writeJsonAtomic(workspace, current, false);
    });
  });
}

export function unregisterProject(options: RuntimeOptions, name: string): boolean {
  return withFileErrors(() => {
    validateName(name);
    const workspace = workspacePath(options);
    return withWorkspaceLock(workspace, () => {
      const current = readWorkspace(workspace);
      const index = current.projects.findIndex((entry) => entry.name === name);
      if (index < 0) return false;
      // Удаляется только ссылка: конфиг, SQLite и данные остаются у проекта.
      current.projects.splice(index, 1);
      writeJsonAtomic(workspace, current, false);
      return true;
    });
  });
}
