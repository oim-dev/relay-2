import { existsSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { DataRepository } from "../transport/repository";
import { transportMessages } from "../transport/transport.messages";
import { decodeSnapshot } from "../snapshot/codec";
import { restoreSnapshot, validateSnapshotHistory } from "../sync/replication-adapter";
import { readPublicationHistory } from "../sync/publication-reader";
import { appMessages } from "./app.messages";
import type { PreparedRestoration, RestorationPreparationInput } from "./restore.types";
import { requireGitExecutionActive } from "../execution/context";

/**
 * Проверяет полную canonical историю и один раз выполняет Core bootstrap в private staging.
 * Все SQLite handles закрываются до возврата; WAL/journal не могут остаться за границей будущей копии.
 * Отмена после Git-подготовки останавливает bootstrap; результат не подтверждает публикацию проекта.
 * Каталог, отказ и cleanup принадлежат вызывающему restore.
 */
export async function prepareRestoration(
  input: RestorationPreparationInput,
): Promise<PreparedRestoration> {
  const repository = new DataRepository({
    directory: join(input.directory, "repository"),
    remote: input.remote,
    branch: input.branch,
  });
  await repository.initialize();
  const head = await repository.fetch();
  if (head === null) {
    throw new RelayError("GIT_BRANCH_MISSING", transportMessages.missing, 3);
  }
  const latest = decodeSnapshot(await repository.files(head), input.projectId);
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
  requireGitExecutionActive();
  const databasePath = join(input.directory, "project.sqlite");
  restoreSnapshot(databasePath, snapshot, { trustedCheckpoint: true });
  const database = ProjectDatabase.open(databasePath);
  let replicaId: string;
  try {
    database.setSynchronizationMode(input.mode);
    replicaId = database.getReplicationStatus().replicaId;
  } finally {
    database.close();
  }
  if (existsSync(databasePath + "-wal") || existsSync(databasePath + "-journal")) {
    throw new RelayError("RESTORE_STAGING_INVALID", appMessages.restoreStaging, 4);
  }
  return {
    projectId: snapshot.projectId,
    replicaId,
    head,
    repository: repository.options.directory,
    databasePath,
  };
}
