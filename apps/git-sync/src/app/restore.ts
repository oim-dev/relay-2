import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import {
  resolveProject,
  restoreProject,
  resumeProjectRestoration,
  type RuntimeOptions,
} from "@relay/project-runtime";
import { DataRepository } from "../transport/repository";
import { resolveRemote, validateBranch } from "../transport/git";
import { decodeSnapshot } from "../snapshot/codec";
import {
  restoreSnapshot,
  validatePreservedDatabase,
  validateSnapshotHistory,
} from "../sync/replication-adapter";
import { readPublicationHistory } from "../sync/publication-reader";
import {
  configuration,
  initialProgress,
  homeDirectory,
  readConfiguration,
  registerConfiguration,
  stateDirectory,
  updateConfiguration,
} from "../local/state";
import type { SyncConfiguration } from "../local/state.types";
import { appMessages } from "./app.messages";
import { requiredString } from "./protocol";
import { transportMessages } from "../transport/transport.messages";
import { writeLocalJson } from "../local/files";
import { DEFAULT_DATA_BRANCH } from "../local/state.constants";
import { ownControl } from "../local/control";

/**
 * Находит сохранённое подключение утраченной базы через диагностику выбора Runtime.
 * Новая реплика с explicit remote не обязана иметь проектную конфигурацию.
 */
export function savedConnection(options: RuntimeOptions): SyncConfiguration | null {
  try {
    const location = resolveProject(options);
    return readConfiguration(stateDirectory(realpathSync(location.databasePath)));
  } catch (error) {
    if (
      error instanceof RelayError &&
      error.code === "DATABASE_NOT_FOUND" &&
      typeof error.details?.path === "string"
    ) {
      const path = error.details.path;
      const physical = join(realpathSync(dirname(path)), basename(path));
      return readConfiguration(stateDirectory(physical));
    }
    throw error;
  }
}

/**
 * Нормализует локальный remote относительно cwd; URL и scp-адреса не меняются.
 */
export async function absoluteRemote(options: RuntimeOptions, value: string): Promise<string> {
  const remote = await resolveRemote(options.cwd, value);
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) ||
    /^[^/\\]+@[^:]+:/.test(remote) ||
    /^[^/\\:]+:[^\\/]/.test(remote)
  ) {
    return remote;
  }
  return resolve(options.cwd, remote);
}

/**
 * Fetch/codec предшествуют созданию БД; предметный bootstrap выполняется только в staging Runtime.
 * Чужая или существующая рабочая база не заменяется, private Git хранится независимо от checkout.
 */
export async function restore(request: GitSyncRequest): Promise<unknown> {
  const input = request.input ?? {};
  if (input.resume !== undefined && typeof input.resume !== "boolean") {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  if (input.resume === true) {
    if (input.remote !== undefined || input.branch !== undefined) {
      throw new RelayError("INVALID_ARGUMENT", appMessages.resumeArguments, 2);
    }
    const result = resumeProjectRestoration(
      request.options,
      input.projectId === undefined ? undefined : requiredString(input.projectId),
      validatePreservedDatabase,
    );
    return {
      ...result,
      message: appMessages.resumed,
      projectId: result.location.projectId,
      databasePath: result.location.databasePath,
      configPath: result.location.configPath,
    };
  }
  if (input.projectId !== undefined) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.resumeArguments, 2);
  }
  let saved: SyncConfiguration | null = null;
  try {
    saved = savedConnection(request.options);
  } catch (error) {
    if (!(
      input.remote !== undefined &&
      error instanceof RelayError &&
      ["PROJECT_NOT_FOUND", "CONFIG_NOT_FOUND"].includes(error.code)
    )) {
      throw error;
    }
  }
  if (!saved && input.remote === undefined) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.remoteRequired, 2);
  }
  const remote =
    input.remote === undefined && saved
      ? saved.remote
      : await absoluteRemote(request.options, requiredString(input.remote));
  const branch =
    input.branch === undefined
      ? (saved?.branch ?? DEFAULT_DATA_BRANCH)
      : requiredString(input.branch);
  if (saved && (saved.remote !== remote || saved.branch !== branch)) {
    throw new RelayError("GIT_ORIGIN_MISMATCH", transportMessages.originMismatch, 4);
  }
  await validateBranch(request.options.cwd, branch);
  const home = homeDirectory(request.options);
  const temporaryRoot = join(home, "git-sync");
  const owner = saved
    ? await ownControl(
        join(stateDirectory(saved.databasePath), "worker.json"),
        "request",
        saved.databasePath,
        async () => {
          throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
        },
      )
    : undefined;
  let temporary: string | undefined;
  try {
    mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
    temporary = mkdtempSync(join(temporaryRoot, "restore-"));
    const repository = new DataRepository({ directory: temporary, remote, branch });
    await repository.initialize();
    const head = await repository.fetch();
    if (!head) {
      throw new RelayError("GIT_BRANCH_MISSING", transportMessages.missing, 3);
    }
    const latest = decodeSnapshot(await repository.files(head), saved?.projectId);
    const snapshot = await readPublicationHistory(
      repository,
      head,
      { decode: decodeSnapshot, validate: validateSnapshotHistory },
      {
        projectId: latest.projectId,
        base: null,
        cache: new Map([[head, latest]]),
      },
    );
    await repository.accepted(head);
    let finalRepository: DataRepository | undefined;
    if (saved) {
      finalRepository = new DataRepository({
        directory: join(stateDirectory(saved.databasePath), "repository"),
        remote,
        branch,
      });
      await finalRepository.initialize();
      await finalRepository.importObjects(temporary, head);
    }
    // Bootstrap Core валидирует полный снимок до публикации файла и конфига Runtime.
    const location = restoreProject(request.options, snapshot.projectId, (path) =>
      restoreSnapshot(path, snapshot, { trustedCheckpoint: true }),
    );
    const config = configuration(location, request.options, remote, branch);
    const directory = stateDirectory(config.databasePath);
    updateConfiguration(directory, (current) => {
      if (current && (current.remote !== remote || current.branch !== branch)) {
        throw new RelayError("GIT_ORIGIN_MISMATCH", transportMessages.originMismatch, 4);
      }
      return current ?? config;
    });
    if (!finalRepository) {
      finalRepository = new DataRepository({
        directory: join(directory, "repository"),
        remote,
        branch,
      });
      await finalRepository.initialize();
      await finalRepository.importObjects(temporary, head);
    }
    await finalRepository.accepted(head);
    const progress = initialProgress();
    progress.git = await finalRepository.counts();
    progress.lastFetch = new Date().toISOString();
    progress.lastSuccess = progress.lastFetch;
    writeLocalJson(join(directory, "progress.json"), progress);
    registerConfiguration(config);
    return {
      restored: true,
      projectId: snapshot.projectId,
      databasePath: location.databasePath,
      configPath: location.configPath,
      branch,
      commit: head,
    };
  } finally {
    try {
      if (temporary) {
        rmSync(temporary, { recursive: true, force: true });
      }
    } finally {
      await owner?.close();
    }
  }
}
