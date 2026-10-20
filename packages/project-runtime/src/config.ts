import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { fileExists, hasCode } from "./files";

export const projectConfigName = join(".relay", "config.json");
export const workspaceConfigName = "relay.workspace.json";

export interface ProjectConfig {
  version: 1;
  projectId: string;
  databasePath: string;
}

export interface WorkspaceConfig {
  version: 1;
  projects: Array<{ name: string; configPath: string }>;
}

export function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readConfig(path: string): ProjectConfig | WorkspaceConfig {
  const invalid = () =>
    new RelayError("INVALID_CONFIG", `Некорректная конфигурация: ${path}`, 2, { path });
  let text: string;
  let directory: string;
  try {
    text = readFileSync(path, "utf8");
    directory = dirname(realpathSync(path));
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw new RelayError("CONFIG_NOT_FOUND", `Конфигурация не найдена: ${path}`, 3, { path });
    }
    if (hasCode(error, "EISDIR")) throw invalid();
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!isObject(data) || data.version !== 1) throw invalid();

  if ("projectId" in data || "databasePath" in data) {
    if (!validText(data.projectId) || !validText(data.databasePath) || "projects" in data) {
      throw invalid();
    }
    return {
      version: 1,
      projectId: data.projectId,
      databasePath: resolve(directory, data.databasePath),
    };
  }

  if (!Array.isArray(data.projects)) throw invalid();
  const names = new Set<string>();
  const projects = data.projects.map((entry: unknown) => {
    if (
      !isObject(entry) ||
      !validText(entry.name) ||
      entry.name !== entry.name.trim() ||
      !validText(entry.configPath) ||
      names.has(entry.name)
    ) {
      throw invalid();
    }
    names.add(entry.name);
    return { name: entry.name, configPath: resolve(directory, entry.configPath) };
  });
  return { version: 1, projects };
}

export function readWorkspace(path: string): WorkspaceConfig {
  const config = readConfig(path);
  if (!("projects" in config)) {
    throw new RelayError("WORKSPACE_REQUIRED", `Ожидается конфигурация workspace: ${path}`, 2, {
      path,
    });
  }
  return config;
}

export function* ancestors(cwd: string): Generator<string> {
  let directory = resolve(cwd);
  for (;;) {
    yield directory;
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

export function findConfig(cwd: string, workspaceOnly: boolean): string | undefined {
  for (const directory of ancestors(cwd)) {
    if (!workspaceOnly) {
      const project = join(directory, projectConfigName);
      if (fileExists(project)) return project;
    }
    const workspace = join(directory, workspaceConfigName);
    if (fileExists(workspace)) return workspace;
  }
  return undefined;
}
