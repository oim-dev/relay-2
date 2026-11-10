import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import {
  initialProgress,
  pendingConfiguration,
  readConfiguration,
  stateDirectory,
  updateConfiguration,
} from "../local/state";
import type { SyncConfiguration } from "../local/state.types";
import { writeLocalJson } from "../local/files";
import { DataRepository } from "../transport/repository";
import { transportMessages } from "../transport/transport.messages";
import {
  initializeProjectRepository,
  projectGitCommonDirectory,
  projectOrigin,
  projectRepositoryOptions,
  requireSameGitRepository,
  requireExistingDataRepository,
} from "./project-connection";
import { requireRestorationSelection } from "./restore-selection";
import type { RestorationTransportInput } from "./restore.types";
import { gitDirectoryIdentity } from "../transport/git-directory-identity";

/**
 * Под owner конечной БД готовит linked worktree и сохраняет подключение до публикации SQLite.
 * Git получает именно replicaId подготовленной Core-реплики; после возврата Git больше не нужен.
 * Независимый clone отклоняется до изменения общего data worktree; отказ не удаляет чужие материалы.
 * Config/root может ещё отсутствовать при явном вложенном пути; создаётся только его каталог.
 */
export async function prepareRestorationTransport(input: RestorationTransportInput): Promise<void> {
  const { source, location, prepared, options } = input;
  const { root, remote, branch, saved, inherited, selected } = source;
  requireRestorationSelection(options, selected);
  mkdirSync(root, { recursive: true });
  const createdRepository = await initializeProjectRepository(root, remote);
  const gitCommonDirectory = await projectGitCommonDirectory(root);
  const gitCommonDirectoryIdentity = gitDirectoryIdentity(gitCommonDirectory);
  const config: SyncConfiguration = {
    ...pendingConfiguration(location, options, remote, branch),
    worktree: root,
    gitCommonDirectory,
    gitCommonDirectoryIdentity,
    mode: saved?.mode ?? "auto",
    ...((inherited || createdRepository) && (await projectOrigin(root)) === remote
      ? { remoteName: "origin" }
      : {}),
  };
  const directory = stateDirectory(location.databasePath);
  const current = readConfiguration(directory);
  requireSameGitRepository(current, gitCommonDirectory, gitCommonDirectoryIdentity);
  await requireExistingDataRepository(location.databasePath, gitCommonDirectory, current);
  const repository = new DataRepository(
    projectRepositoryOptions(directory, config, prepared.replicaId),
  );
  await repository.initialize();
  await repository.importObjects(prepared.repository, prepared.head);
  // Core принял этот head в private staging; публичной SQLite ещё нет.
  await repository.accepted(prepared.head);
  const progress = initialProgress();
  progress.git = await repository.counts();
  progress.lastFetch = new Date().toISOString();
  progress.lastSuccess = progress.lastFetch;
  requireRestorationSelection(options, selected);
  updateConfiguration(directory, (current) => {
    requireSameGitRepository(current, gitCommonDirectory, gitCommonDirectoryIdentity);
    if (
      current &&
      (current.projectId !== config.projectId ||
        current.remote !== remote ||
        current.branch !== branch)
    ) {
      throw new RelayError("GIT_ORIGIN_MISMATCH", transportMessages.originMismatch, 4);
    }
    return config;
  });
  writeLocalJson(join(directory, "progress.json"), progress);
}
