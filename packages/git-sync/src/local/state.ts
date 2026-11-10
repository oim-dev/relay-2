import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";
import { withLocalFileLock } from "@relay/storage";
import {
  resolveRelayHome,
  type ProjectLocation,
  type RuntimeOptions,
} from "@relay/project-runtime";
import { appMessages } from "../app/app.messages";
import { decodeResponse, requestObject, requiredString } from "../app/protocol";
import { SYNC_PHASES } from "./state.constants";
import { readLocalJson, writeLocalJson } from "./files";
import type { SyncConfiguration, SyncProgress } from "./state.types";
import { readPublicationWindow } from "./publication-progress";

/**
 * Привязывает служебные файлы к физической базе, а не к home, checkout или workspace alias.
 */
export function stateDirectory(databasePath: string): string {
  return basename(databasePath) === "project.sqlite"
    ? join(dirname(databasePath), "state")
    : `${databasePath}.git-sync`;
}

/**
 * Выбирает единственный linked worktree физической SQLite вне checkout исходников.
 * Нестандартное имя БД получает собственный sidecar, чтобы соседние override-базы не делили data.
 */
export function dataDirectory(databasePath: string): string {
  return basename(databasePath) === "project.sqlite"
    ? join(dirname(databasePath), "data")
    : join(stateDirectory(databasePath), "data");
}

/**
 * Вычисляет home из явно переданного контекста; не читает окружение внутри сценариев.
 */
export function homeDirectory(options: RuntimeOptions): string {
  return resolveRelayHome(options);
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
  return pendingConfiguration(
    {
      ...location,
      databasePath: realpathSync(location.databasePath),
      configPath: realpathSync(location.configPath),
    },
    options,
    remote,
    branch,
  );
}

/**
 * Готовит подключение до публикации файлов. Пути уже физически разрешены Runtime restore resolver.
 * Не создаёт файлов; вызывающий сериализует сохранение вместе с публикацией проекта.
 */
export function pendingConfiguration(
  location: ProjectLocation,
  options: RuntimeOptions,
  remote: string,
  branch: string,
): SyncConfiguration {
  return {
    version: 1,
    projectId: location.projectId,
    databasePath: location.databasePath,
    configPath: location.configPath,
    worktree: dirname(location.configPath),
    home: homeDirectory(options),
    remote,
    branch,
    mode: "auto",
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
  if (item.version !== 1 || !["auto", "manual"].includes(String(item.mode))) {
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
    worktree: requiredString(item.worktree),
    ...(item.gitCommonDirectory === undefined
      ? {}
      : { gitCommonDirectory: requiredString(item.gitCommonDirectory) }),
    ...(item.gitCommonDirectoryIdentity === undefined
      ? {}
      : { gitCommonDirectoryIdentity: requiredString(item.gitCommonDirectoryIdentity) }),
    ...(item.remoteName === undefined ? {} : { remoteName: requiredString(item.remoteName) }),
  };
}

/**
 * Сериализует смену подключения между обращениями CLI; совпадающее содержимое не переписывает файл.
 */
export function updateConfiguration(
  directory: string,
  update: (current: SyncConfiguration | null) => SyncConfiguration,
): SyncConfiguration {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "connection.json");
  return withLocalFileLock(path, () => {
    const current = readConfiguration(directory);
    const result = update(current);
    if (JSON.stringify(result) !== JSON.stringify(current)) {
      writeLocalJson(path, result);
    }
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
