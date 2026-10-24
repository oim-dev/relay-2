import { join } from "node:path";
import type { ReplicationStatus } from "@relay/contracts";
import { initialProgress, readProgress } from "../local/state";
import { controlRequest, readEndpoint } from "../local/control";
import { requestObject } from "../app/protocol";
import type { SyncConfiguration, SyncProgress } from "../local/state.types";
import type { ControlEndpoint } from "../local/control.types";
import { COMPONENT_RELEASE } from "../local/control";
import { processTreeCapability, readSshCapability } from "../transport/ssh-state";

/**
 * Формирует наблюдаемость worker по challenge-response, никогда не по наличию PID-файла.
 */
export async function workerStatus(
  path: string,
  desired: "running" | "stopped",
  own?: ControlEndpoint,
): Promise<Record<string, unknown>> {
  const endpoint = own ?? readEndpoint(path);
  let health: Record<string, unknown> | null = null;
  if (endpoint) {
    const response = await controlRequest(endpoint, "health");
    if (response?.ok) {
      const value = requestObject(response.data);
      if (
        value.instance === endpoint.instance &&
        value.identity === endpoint.identity &&
        value.kind === endpoint.kind &&
        value.release === COMPONENT_RELEASE &&
        value.version === 1
      ) {
        health = value;
      }
    }
  }
  let actual = "unknown";
  if (health) {
    actual = "running";
  } else if (!endpoint && desired === "stopped") {
    actual = "stopped";
  }
  return {
    desired,
    actual,
    responsive: health !== null,
    version: health?.release ?? endpoint?.release ?? null,
    instance: endpoint?.instance ?? null,
    started: health?.startedAt ?? endpoint?.startedAt ?? null,
    heartbeat: health?.heartbeat ?? null,
    pid: endpoint?.pid ?? null,
    binaryVersion: endpoint?.release.split("/")[0] ?? null,
    protocolVersion: endpoint?.version ?? null,
    kind: endpoint?.kind ?? null,
    supervisorInstance: endpoint?.supervisorInstance ?? null,
  };
}

/**
 * Читает локальную диагностику без network; Git counts и durable outbox имеют независимые поля.
 */
export async function syncStatus(
  directory: string,
  config: SyncConfiguration | null,
  replication: ReplicationStatus,
  current?: SyncProgress,
  own?: ControlEndpoint,
): Promise<Record<string, unknown>> {
  const saved = current ?? readProgress(directory);
  const sameQueue =
    saved.publicationReplicaId === null ||
    (saved.publicationReplicaId === replication.replicaId &&
      (config === null || saved.publicationDatabaseIdentity === config.databasePath));
  const progress = sameQueue ? saved : initialProgress();
  const producer = await workerStatus(
    join(directory, "worker.json"),
    config?.desired ?? "stopped",
    own,
  );
  const worker =
    producer.kind === "request"
      ? {
          desired: producer.desired,
          actual: "stopped",
          responsive: false,
          version: null,
          instance: null,
          started: null,
          heartbeat: null,
          pid: null,
          binaryVersion: null,
          protocolVersion: null,
          kind: null,
          supervisorInstance: null,
        }
      : producer;
  let unexported: number | null = null;
  if (progress.exportedCount === 0) {
    unexported = replication.pending;
  } else if (progress.exportedGeneration === replication.generation) {
    unexported = Math.max(0, replication.pending - progress.exportedCount);
  }
  const scheduled =
    producer.responsive &&
    progress.nextRetry !== null &&
    (progress.phase === "retrying" || config?.mode === "auto");
  let nextReason = "polling";
  if (progress.phase === "retrying") {
    nextReason = "contention";
  } else if (progress.error) {
    nextReason = "network-retry";
  } else if (progress.publicationWindow?.hasMore) {
    nextReason = "publication-window";
  }
  let conflictFreshness = "unknown";
  if (progress.conflictsObservedAt !== null) {
    conflictFreshness =
      progress.conflictsHead === progress.git.remoteHead &&
      progress.conflictsGeneration === replication.generation
        ? "current"
        : "stale";
    if (!progress.conflictsComplete) {
      conflictFreshness = "partial";
    }
  }
  return {
    connected: config !== null,
    projectId: config?.projectId ?? null,
    replicaId: replication.replicaId,
    databaseIdentity: config?.databasePath ?? directory.slice(0, -".git-sync".length),
    branch: config?.branch ?? null,
    worker,
    request: producer.kind === "request" ? producer : null,
    mode: config?.mode ?? "manual",
    phase: producer.responsive ? progress.phase : "idle",
    attemptId: producer.responsive ? progress.attemptId : null,
    git: progress.git,
    transport: {
      processTree: processTreeCapability(),
      detachedGitMaintenance: false,
      ssh: readSshCapability(join(directory, "repository")),
    },
    pending: {
      changesets: replication.pending,
      oldest: replication.oldest,
      oldestAgeMs:
        replication.oldest === null
          ? null
          : Math.max(0, Date.now() - Date.parse(replication.oldest)),
      unexported,
    },
    publication: {
      afterSequence: progress.afterSequence,
      window: progress.publicationWindow,
    },
    lastFetch: progress.lastFetch,
    lastSuccess: progress.lastSuccess,
    lastAttempt: progress.lastAttempt,
    lastAttemptId: progress.attemptId,
    nextRetry: scheduled ? progress.nextRetry : null,
    nextAttempt: scheduled
      ? {
          at: progress.nextRetry,
          instance: producer.instance,
          reason: nextReason,
        }
      : null,
    freshness: {
      asOf: progress.lastFetch,
      remoteHead: progress.git.remoteHead,
      known: progress.lastFetch !== null,
    },
    conflicts: {
      count: replication.conflicts,
      freshness: conflictFreshness,
      asOf: progress.conflictsObservedAt,
      remoteHead: progress.conflictsHead,
      generation: progress.conflictsGeneration,
    },
    error: progress.error,
  };
}
