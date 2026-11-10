import { join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import { combineProcessFailures } from "@relay/project-runtime";
import { DataRepository } from "../transport/repository";
import { validateBranch } from "../transport/git";
import { transportMessages } from "../transport/transport.messages";
import type { ReplicationAdapter } from "../sync/replication-adapter";
import { SyncEngine } from "../sync/engine";
import { readConfiguration, updateConfiguration } from "../local/state";
import type { SyncConfiguration } from "../local/state.types";
import { ownControl } from "../local/control";
import { NetworkExchange } from "../sync/network-exchange";
import { appMessages } from "./app.messages";
import {
  initializeProjectRepository,
  projectGitCommonDirectory,
  projectRepositoryOptions,
  requireCurrentProject,
  requireSameGitRepository,
  requireExistingDataRepository,
} from "./project-connection";
import { requireGitExecutionActive } from "../execution/context";
import { gitDirectoryIdentity } from "../transport/git-directory-identity";

/**
 * Не разрешает connect подменять существующий проект, remote или ветку.
 */
function requireSameConnection(current: SyncConfiguration, initial: SyncConfiguration): void {
  if (
    current.projectId !== initial.projectId ||
    current.databasePath !== initial.databasePath ||
    current.remote !== initial.remote ||
    current.branch !== initial.branch
  ) {
    throw new RelayError("GIT_ORIGIN_MISMATCH", transportMessages.originMismatch, 4);
  }
}

/**
 * Подключает после read-only fetch/validation; worktree, сеть и запись connection защищены одним owner.
 * Более новый manual mode сохраняется; адресат существующего подключения не заменяется.
 * При отказе cleanup сохраняет первичную ошибку обмена вместе с ошибкой закрытия owner.
 */
export async function connect(
  request: GitSyncRequest,
  directory: string,
  initial: SyncConfiguration,
  replication: ReplicationAdapter,
): Promise<SyncConfiguration> {
  const existing = readConfiguration(directory);
  if (existing !== null) {
    requireSameGitRepository(existing, await projectGitCommonDirectory(initial.worktree));
    requireSameConnection(existing, initial);
    return existing;
  }
  await validateBranch(request.options.cwd, initial.branch);
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), 60_000);
  try {
    const owner = await ownControl(
      join(directory, "worker.json"),
      "request",
      initial.databasePath,
      async () => {
        throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
      },
      async () => requireCurrentProject(directory, initial, replication),
    );
    let outcome: PromiseSettledResult<SyncConfiguration>;
    try {
      requireGitExecutionActive();
      const created = await initializeProjectRepository(initial.worktree, initial.remote);
      const gitCommonDirectory = await projectGitCommonDirectory(initial.worktree);
      const prepared = {
        ...initial,
        gitCommonDirectory,
        gitCommonDirectoryIdentity: gitDirectoryIdentity(gitCommonDirectory),
      };
      const current = readConfiguration(directory);
      requireSameGitRepository(current, gitCommonDirectory, prepared.gitCommonDirectoryIdentity);
      await requireExistingDataRepository(initial.databasePath, gitCommonDirectory, current);
      const repository = new DataRepository(
        projectRepositoryOptions(
          directory,
          prepared,
          replication.status().replicaId,
          cancellation.signal,
        ),
      );
      const engine = new SyncEngine(
        directory,
        initial.projectId,
        replication,
        repository,
        cancellation.signal,
      );
      const exchange = new NetworkExchange(engine, cancellation.signal, {
        /**
         * Worktree инициализируется под тем же lease, что read-only fetch.
         */
        async prepare(_refresh, signal): Promise<void> {
          repository.setAttemptSignal(signal);
          try {
            await repository.initialize();
          } finally {
            repository.setAttemptSignal(null);
          }
        },
      });
      requireGitExecutionActive();
      await exchange.run(true);
      requireGitExecutionActive();
      const result = updateConfiguration(directory, (current) => {
        if (current !== null) {
          requireSameGitRepository(
            current,
            gitCommonDirectory,
            prepared.gitCommonDirectoryIdentity,
          );
          requireSameConnection(current, initial);
          return current;
        }
        return {
          ...prepared,
          mode: replication.schedule().mode,
          ...(created ? { remoteName: "origin" } : {}),
        };
      });
      outcome = { status: "fulfilled", value: result };
    } catch (reason) {
      outcome = { status: "rejected", reason };
    }
    try {
      await owner.close();
    } catch (cleanupError) {
      throw outcome.status === "rejected"
        ? combineProcessFailures(outcome.reason, cleanupError)
        : cleanupError;
    }
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
    return outcome.value;
  } finally {
    clearTimeout(timer);
    cancellation.abort();
  }
}
