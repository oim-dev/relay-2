import { realpathSync } from "node:fs";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/core";
import { openProject, type OpenedProject } from "@relay/project-runtime";
import { readConfiguration, stateDirectory } from "../local/state";
import { appMessages } from "../app/app.messages";
import { snapshotMessages } from "../snapshot/snapshot.messages";
import type { WorkerOptions } from "./context.types";

/**
 * Обычный выбор делегирует Runtime; явную уже подключённую БД открывает публичным Storage API.
 * Кодовый config не нужен explicit database, но сохранённый project ID обязательно совпадает.
 */
export function openWorkerProject(options: WorkerOptions): OpenedProject {
  if (options.databasePath === undefined) {
    return openProject(options);
  }
  const databasePath = realpathSync(options.databasePath);
  const config = readConfiguration(stateDirectory(databasePath));
  if (!config) {
    throw new RelayError("GIT_SYNC_NOT_CONNECTED", appMessages.notConnected, 4);
  }
  const database = ProjectDatabase.open(databasePath);
  if (
    database.projectId !== config.projectId ||
    (options.expectedProjectId !== undefined && database.projectId !== options.expectedProjectId)
  ) {
    database.close();
    throw new RelayError("GIT_PROJECT_MISMATCH", snapshotMessages.project, 4);
  }
  if (
    options.expectedReplicaId !== undefined &&
    database.getReplicationStatus().replicaId !== options.expectedReplicaId
  ) {
    database.close();
    throw new RelayError("GIT_REPLICA_MISMATCH", appMessages.incompatible, 4);
  }
  return {
    database,
    location: { databasePath, projectId: database.projectId, configPath: config.configPath },
  };
}
