import type { HttpGitSyncStatus } from "@relay/contracts";
import type { ProjectSynchronization, SynchronizationRequest } from "./synchronization.types";

/**
 * Не выводит доставку из SSE, последнего success или неизвестных счётчиков.
 * Исход ручного запроса хранится отдельно от cached Runtime status.
 */
export function projectSynchronization(
  status: HttpGitSyncStatus,
  request?: SynchronizationRequest,
): ProjectSynchronization {
  let state: ProjectSynchronization["state"] = "unknown";
  if (status.connected === false) state = "local";
  else if (status.conflicts.count !== null && status.conflicts.count > 0) state = "conflict";
  else if (status.error !== null) state = "offline";
  else if (
    status.worker.actual === "running" &&
    status.worker.responsive === true &&
    status.phase !== "idle" &&
    status.phase !== null
  )
    state = "syncing";
  else if (status.pending.changesets !== null && status.pending.changesets > 0) state = "pending";
  else if (
    status.connected === true &&
    status.pending.changesets === 0 &&
    status.pending.unexported === 0 &&
    status.conflicts.count === 0 &&
    status.conflicts.freshness === "current" &&
    status.freshness.known === true &&
    status.lastSuccess !== null
  )
    state = "synced";
  return {
    isGit: true,
    state,
    queuedCommits: status.pending.changesets,
    hasUncommittedChanges:
      status.pending.unexported === null ? null : status.pending.unexported > 0,
    lastSuccessAt: status.lastSuccess,
    nextAttemptAt: null,
    origin: status.connected === true ? "connected" : null,
    error: status.error?.message ?? null,
    requestState: request?.state ?? null,
    requestId: request?.requestId ?? null,
    requestError: request?.error ?? null,
  };
}
