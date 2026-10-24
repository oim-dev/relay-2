import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { RelayError } from "@relay/contracts";
import { withLocalFileLock } from "@relay/storage";
import type { ProjectLocation, RuntimeOptions } from "@relay/project-runtime";
import { appMessages } from "../app/app.messages";
import { decodeResponse, requestObject, requiredString } from "../app/protocol";
import { SYNC_PHASES } from "./state.constants";
import { readLocalJson, writeLocalJson } from "./files";
import type { RegisteredProject, SyncConfiguration, SyncProgress } from "./state.types";
import { readPublicationWindow } from "./publication-progress";

/**
 * Привязывает служебные файлы к физической базе, а не к home, checkout или workspace alias.
 */
export function stateDirectory(databasePath: string): string {
  return `${databasePath}.git-sync`;
}

/**
 * Вычисляет home из явно переданного контекста; не читает окружение внутри сценариев.
 */
export function homeDirectory(options: RuntimeOptions): string {
  return resolve(options.cwd, options.home ?? join(homedir(), ".relay"));
}

/**
 * Создаёт конфигурацию уже выбранного Runtime проекта; symlink сводит к одной физической базе.
 */
export function configuration(
  location: ProjectLocation,
  options: RuntimeOptions,
  remote: string,
  branch: string,
): SyncConfiguration {
  return {
    version: 1,
    projectId: location.projectId,
    databasePath: realpathSync(location.databasePath),
    configPath: realpathSync(location.configPath),
    home: homeDirectory(options),
    remote,
    branch,
    mode: "manual",
    desired: "stopped",
    controlRevision: 0,
  };
}

/**
 * Проверяет локальную конфигурацию, не скрывая повреждение значениями по умолчанию.
 */
export function readConfiguration(directory: string): SyncConfiguration | null {
  const value = readLocalJson(join(directory, "connection.json"));
  if (value === undefined) {
    return null;
  }
  const item = requestObject(value);
  if (
    item.version !== 1 ||
    !["auto", "manual"].includes(String(item.mode)) ||
    !["running", "stopped"].includes(String(item.desired))
  ) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  return {
    version: 1,
    projectId: requiredString(item.projectId),
    databasePath: requiredString(item.databasePath),
    configPath: requiredString(item.configPath),
    home: requiredString(item.home),
    remote: requiredString(item.remote),
    branch: requiredString(item.branch),
    mode: item.mode === "auto" ? "auto" : "manual",
    desired: item.desired === "running" ? "running" : "stopped",
    controlRevision: nullableCount(item.controlRevision ?? 0) ?? 0,
  };
}

/**
 * Сериализует изменение подключения и desired/mode между CLI и supervisor.
 */
export function updateConfiguration(
  directory: string,
  update: (current: SyncConfiguration | null) => SyncConfiguration,
): SyncConfiguration {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "connection.json");
  return withLocalFileLock(path, () => {
    const current = readConfiguration(directory);
    const result = { ...update(current), controlRevision: (current?.controlRevision ?? 0) + 1 };
    writeLocalJson(path, result);
    return result;
  });
}

/**
 * Возвращает чистую наблюдаемость нового соединения.
 */
export function initialProgress(): SyncProgress {
  return {
    publicationReplicaId: null,
    publicationDatabaseIdentity: null,
    afterSequence: 0,
    publicationWindow: null,
    phase: "idle",
    attemptId: null,
    git: { localHead: null, remoteHead: null, ahead: null, behind: null },
    conflictsHead: null,
    conflictsGeneration: null,
    conflictsObservedAt: null,
    conflictsComplete: false,
    lastFetch: null,
    lastSuccess: null,
    lastAttempt: null,
    nextRetry: null,
    exportedGeneration: null,
    exportedCount: 0,
    error: null,
  };
}

/**
 * Читает диагностику прошлой попытки; локальная форма проверяется до использования.
 */
function nullableText(value: unknown): string | null {
  return value === null ? null : requiredString(value);
}

/**
 * Проверяет неотрицательный сохранённый счётчик, сохраняя неизвестное null.
 */
function nullableCount(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  return value;
}

/**
 * Проверяет фазу по единственному перечню локального формата.
 */
function syncPhase(value: unknown): value is SyncProgress["phase"] {
  return SYNC_PHASES.some((phase) => phase === value);
}

/**
 * Читает только проверенную диагностику, не скрывая повреждённые счётчики нулями.
 */
export function readProgress(directory: string): SyncProgress {
  const value = readLocalJson(join(directory, "progress.json"));
  if (value === undefined) {
    return initialProgress();
  }
  const item = requestObject(value);
  if (
    !syncPhase(item.phase) ||
    typeof item.exportedCount !== "number" ||
    !Number.isSafeInteger(item.exportedCount) ||
    item.exportedCount < 0 ||
    (item.exportedGeneration !== null &&
      (typeof item.exportedGeneration !== "number" ||
        !Number.isSafeInteger(item.exportedGeneration))) ||
    (item.conflictsComplete !== undefined && typeof item.conflictsComplete !== "boolean") ||
    [item.lastFetch, item.lastSuccess, item.lastAttempt, item.nextRetry].some(
      (field) => field !== null && typeof field !== "string",
    )
  ) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  const git = requestObject(item.git);
  let error: SyncProgress["error"] = null;
  if (item.error !== null) {
    const fields = requestObject(item.error);
    const response = decodeResponse({ version: 1, ok: false, error: fields });
    if (!response.ok) {
      error = {
        ...response.error,
        at: requiredString(fields.at),
        operation: requiredString(fields.operation),
      };
    }
  }
  return {
    publicationReplicaId: nullableText(item.publicationReplicaId ?? null),
    publicationDatabaseIdentity: nullableText(item.publicationDatabaseIdentity ?? null),
    afterSequence: nullableCount(item.afterSequence ?? 0) ?? 0,
    publicationWindow: readPublicationWindow(item.publicationWindow),
    phase: item.phase,
    conflictsHead: nullableText(item.conflictsHead ?? null),
    conflictsGeneration: nullableCount(item.conflictsGeneration ?? null),
    conflictsObservedAt: nullableText(item.conflictsObservedAt ?? null),
    conflictsComplete: item.conflictsComplete === true,
    attemptId: nullableText(item.attemptId),
    git: {
      localHead: nullableText(git.localHead),
      remoteHead: nullableText(git.remoteHead),
      ahead: nullableCount(git.ahead),
      behind: nullableCount(git.behind),
    },
    lastFetch: nullableText(item.lastFetch),
    lastSuccess: nullableText(item.lastSuccess),
    lastAttempt: nullableText(item.lastAttempt),
    nextRetry: nullableText(item.nextRetry),
    exportedGeneration: nullableCount(item.exportedGeneration),
    exportedCount: item.exportedCount,
    error,
  };
}

/**
 * Читает явные регистрации supervisor; не открывает базы и не обходит workspace.
 */
export function registeredProjects(home: string): RegisteredProject[] {
  const value = readLocalJson(join(home, "git-sync", "registry.json"));
  if (value === undefined) {
    return [];
  }
  const registry = requestObject(value);
  if (registry.version !== 1 || !Array.isArray(registry.projects)) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  return registry.projects.map((value) => {
    const project = requestObject(value);
    const options = requestObject(project.options);
    return {
      databasePath: requiredString(project.databasePath),
      options: {
        cwd: requiredString(options.cwd),
        config: requiredString(options.config),
        home: requiredString(options.home),
      },
    };
  });
}

/**
 * Регистрирует физическую БД один раз; повтор через другое имя workspace не создаёт worker.
 */
export function registerConfiguration(config: SyncConfiguration): void {
  const path = join(config.home, "git-sync", "registry.json");
  mkdirSync(join(config.home, "git-sync"), { recursive: true, mode: 0o700 });
  withLocalFileLock(path, () => {
    const projects = registeredProjects(config.home).filter(
      (entry) => entry.databasePath !== config.databasePath,
    );
    projects.push({
      databasePath: config.databasePath,
      options: { cwd: config.home, config: config.configPath, home: config.home },
    });
    projects.sort((left, right) => left.databasePath.localeCompare(right.databasePath));
    writeLocalJson(path, { version: 1, projects });
  });
}
