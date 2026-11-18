import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import { openProject, type OpenedProject } from "@relay/project-runtime";
import { absoluteRemote } from "../transport/git";
import { ReplicationAdapter } from "../sync/replication-adapter";
import {
  configuration,
  readConfiguration,
  stateDirectory,
  updateConfiguration,
} from "../local/state";
import type { SyncConfiguration } from "../local/state.types";
import { syncStatus } from "../sync/status";
import { getConflict, listConflicts, resolveConflictRequest } from "./conflicts";
import { resolveKeyConflictRequest } from "./key-conflicts";
import { appMessages } from "./app.messages";
import { requiredString } from "./protocol";
import { restore } from "./restore";
import { connected, discoverProjectConnection, projectOrigin } from "./project-connection";
import { connectionMessages } from "./project-connection.messages";
import { DEFAULT_DATA_BRANCH } from "../local/state.constants";
import { operationId } from "../local/operations";
import { getOperation, operationWait, waitOperation } from "../local/operation-client";
import { oneShot } from "./one-shot";
import { connect } from "./connect";
import { automaticExchange } from "./automatic";
import { requireGitExecutionActive } from "../execution/context";

/**
 * Новый явный запрос получает собственный owner/budget; requestId только читает прежний outcome без Git.
 */
async function explicitExchange(
  request: GitSyncRequest,
  project: OpenedProject,
  directory: string,
  config: SyncConfiguration | null,
  replication: ReplicationAdapter,
): Promise<unknown> {
  const input = request.input ?? {};
  if (input.requestId !== undefined) {
    return waitOperation(directory, operationId(input.requestId), operationWait(input.waitMs));
  }
  const discovered = await discoverProjectConnection(project.location, request.options, config);
  requireGitExecutionActive();
  if (discovered === null) {
    throw new RelayError("GIT_REMOTE_NOT_CONFIGURED", connectionMessages.missing, 4);
  }
  return oneShot({
    directory,
    config: discovered,
    expectedConfiguration: config,
    replication,
    refresh: request.action === "status",
    id: operationId(input.operationId ?? crypto.randomUUID()),
    timeoutMs: operationWait(input.waitMs),
  });
}

/**
 * Исполняет проверенный request и владеет одним предметным соединением до завершения всех async операций.
 * One-shot/restore/connect вынесены к владельцам lifecycle; представление остаётся в CLI/Server.
 */
export async function executeAction(request: GitSyncRequest): Promise<unknown> {
  requireGitExecutionActive();
  if (request.action === "restore") {
    return restore(request);
  }
  if (
    ![
      "connect",
      "auto",
      "status",
      "now",
      "auto.enable",
      "auto.disable",
      "conflicts.list",
      "conflicts.get",
      "conflicts.resolve",
      "keys.list",
      "keys.resolve",
      "request.get",
    ].includes(request.action)
  ) {
    throw new RelayError("GIT_SYNC_UNKNOWN_ACTION", appMessages.action, 2);
  }
  const project = openProject(request.options);
  try {
    const directory = stateDirectory(realpathSync(project.location.databasePath));
    const input = request.input ?? {};
    const replication = new ReplicationAdapter(project.database);
    let config = readConfiguration(directory);
    switch (request.action) {
      case "auto":
        return await automaticExchange(request, project, directory, config, replication);
      case "request.get":
        return await getOperation(directory, operationId(input.requestId ?? input.id));
      case "connect": {
        const root = dirname(realpathSync(project.location.configPath));
        const inherited = input.remote === "origin";
        const remote = inherited
          ? await projectOrigin(root)
          : await absoluteRemote(root, requiredString(input.remote));
        if (remote === null) {
          throw new RelayError("GIT_REMOTE_NOT_CONFIGURED", connectionMessages.missing, 4);
        }
        const branch =
          input.branch === undefined ? DEFAULT_DATA_BRANCH : requiredString(input.branch);
        config = await connect(
          request,
          directory,
          {
            ...configuration(project.location, request.options, remote, branch),
            worktree: root,
            mode: replication.schedule().mode,
            ...(inherited ? { remoteName: "origin" } : {}),
          },
          replication,
        );
        break;
      }
      case "status":
        if (input.refresh !== undefined && typeof input.refresh !== "boolean") {
          throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
        }
        if (input.refresh === true) {
          return await explicitExchange(request, project, directory, config, replication);
        }
        break;
      case "now":
        return await explicitExchange(request, project, directory, config, replication);
      case "auto.enable":
        project.database.setSynchronizationMode("auto");
        if (config !== null) {
          config = updateConfiguration(directory, (current) => ({
            ...connected(current),
            mode: "auto",
          }));
        }
        break;
      case "auto.disable":
        project.database.setSynchronizationMode("manual");
        if (config !== null) {
          config = updateConfiguration(directory, (current) => ({
            ...connected(current),
            mode: "manual",
          }));
        }
        break;
      case "conflicts.list":
        return listConflicts(replication);
      case "conflicts.get":
        return getConflict(replication, requiredString(input.id));
      case "conflicts.resolve":
        return resolveConflictRequest(replication, input);
      case "keys.list":
        return replication.keyConflicts();
      case "keys.resolve":
        return resolveKeyConflictRequest(replication, input);
    }
    return {
      ...(await syncStatus(directory, config, replication.status())),
      projectId: project.location.projectId,
      databaseIdentity: replication.databaseIdentity,
      mode: replication.schedule().mode,
      schedule: replication.schedule(),
    };
  } finally {
    project.database.close();
  }
}
