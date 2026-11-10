import { constants, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import {
  combineProcessFailures,
  resolveVacantRestorationTarget,
  restoreProject,
  resumeProjectRestoration,
} from "@relay/project-runtime";
import { validatePreservedDatabase } from "../sync/replication-adapter";
import { stateDirectory } from "../local/state";
import type { ControlOwner } from "../local/control.types";
import { ownControl } from "../local/control";
import { appMessages } from "./app.messages";
import { requiredString } from "./protocol";
import { prepareRestoration } from "./restore-preparation";
import { prepareRestorationTransport } from "./restore-transport";
import {
  requireRestorationSelection,
  restorationTransportLocation,
  selectRestorationSource,
} from "./restore-selection";

/**
 * Локальный resume принадлежит Runtime и не запускает fetch, bootstrap или Git acceptance.
 */
function resumeRestoration(request: GitSyncRequest): unknown {
  const input = request.input ?? {};
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

/**
 * Восстанавливает проект под transport owner; Git полностью готов до публикации SQLite.
 * Без config подготовкой владеет mutex физического config в home, после fetch — также mutex ID/state.
 * Оба удерживаются до публикации и cleanup, чтобы разные config не присвоили один data worktree.
 * Private closed staging содержит будущий replicaId; Runtime публикует его точную копию.
 * Отказ Runtime сохраняет его recovery-материалы и предварительное подключение.
 * После публикации нет Git; cleanup всех собственных ресурсов сохраняет первичную причину отказа.
 */
export async function restore(request: GitSyncRequest): Promise<unknown> {
  const input = request.input ?? {};
  if (input.resume !== undefined && typeof input.resume !== "boolean") {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  if (input.resume === true) {
    return resumeRestoration(request);
  }
  if (input.projectId !== undefined) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.resumeArguments, 2);
  }
  const source = await selectRestorationSource(request);
  const { selected, preparationDirectory, saved, remote, branch } = source;
  const owner = await ownControl(
    join(preparationDirectory, "worker.json"),
    "request",
    selected.databasePath ?? selected.configPath,
    async () => {
      throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
    },
  );
  let projectOwner: ControlOwner | undefined;
  let temporary: string | undefined;
  let outcome: PromiseSettledResult<unknown>;
  try {
    requireRestorationSelection(request.options, selected);
    const expectedProjectId = selected.projectId ?? saved?.projectId;
    if (expectedProjectId !== undefined) {
      resolveVacantRestorationTarget(request.options, expectedProjectId);
    }
    temporary = mkdtempSync(join(preparationDirectory, "restore-"));
    const prepared = await prepareRestoration({
      directory: temporary,
      remote,
      branch,
      projectId: expectedProjectId,
      mode: saved?.mode ?? "auto",
    });
    const location = restorationTransportLocation(
      request.options,
      prepared.projectId,
      selected.configPath,
    );
    if (selected.databasePath === null) {
      projectOwner = await ownControl(
        join(stateDirectory(location.databasePath), "worker.json"),
        "request",
        location.databasePath,
        async () => {
          throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
        },
      );
      resolveVacantRestorationTarget(request.options, prepared.projectId);
    }
    await prepareRestorationTransport({ options: request.options, source, location, prepared });
    const published = restoreProject(request.options, prepared.projectId, (path) =>
      copyFileSync(prepared.databasePath, path, constants.COPYFILE_EXCL),
    );
    outcome = {
      status: "fulfilled",
      value: {
        restored: true,
        projectId: published.projectId,
        databasePath: published.databasePath,
        configPath: published.configPath,
        branch,
        commit: prepared.head,
      },
    };
  } catch (reason) {
    outcome = { status: "rejected", reason };
  }
  const cleanupFailures: unknown[] = [];
  if (temporary !== undefined) {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (cause) {
      const failure = new RelayError("GIT_CLEANUP_FAILED", appMessages.restoreCleanup, 1, {
        operation: "restore-staging-cleanup",
        path: temporary,
      });
      failure.cause = cause;
      cleanupFailures.push(failure);
    }
  }
  if (projectOwner !== undefined) {
    try {
      await projectOwner.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await owner.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length > 0) {
    const cleanupError = cleanupFailures.reduce(combineProcessFailures);
    throw outcome.status === "rejected"
      ? combineProcessFailures(outcome.reason, cleanupError)
      : cleanupError;
  }
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}
