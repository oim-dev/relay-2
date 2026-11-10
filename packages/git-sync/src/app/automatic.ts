import { join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import {
  combineProcessFailures,
  SYNC_DEBOUNCE,
  synchronizationDueAt,
  synchronizationRetryDelay,
  type OpenedProject,
} from "@relay/project-runtime";
import type { ReplicationAdapter } from "../sync/replication-adapter";
import type { SyncConfiguration } from "../local/state.types";
import { acquireControlLock } from "../local/control";
import { discoverProjectConnection, requireProjectReplica } from "./project-connection";
import { oneShot } from "./one-shot";
import { gitExecutionSignal, requireGitExecutionActive } from "../execution/context";

/**
 * Обслуживает durable debounce без постоянного worker. Даже no-remote/discovery error пишет расписание
 * только под общим transport mutex, не вмешиваясь в результат другого активного/завершившегося owner.
 */
export async function automaticExchange(
  request: GitSyncRequest,
  project: OpenedProject,
  directory: string,
  config: SyncConfiguration | null,
  replication: ReplicationAdapter,
): Promise<unknown> {
  const startedAt = Date.now();
  const schedule = replication.schedule();
  const dueAt = synchronizationDueAt(schedule);
  const disabled = schedule.mode === "manual";
  if (Date.now() < dueAt || disabled) {
    return {
      state: "deferred",
      reason: disabled ? "disabled" : "debounce",
      dueAt: Number.isFinite(dueAt) ? dueAt : null,
    };
  }
  /**
   * Короткое обновление без endpoint и Git; false означает, что актуальный owner/режим уже отменил попытку.
   */
  function recordIdleAttempt(failed: boolean): boolean {
    let lock;
    try {
      lock = acquireControlLock(join(directory, "worker.json"));
    } catch (error) {
      if (error instanceof RelayError && error.code === "GIT_SYNC_WORKER_BUSY") {
        return false;
      }
      throw error;
    }
    try {
      requireProjectReplica(request.options, project.location, replication.status().replicaId);
      const current = replication.schedule();
      if (
        current.mode === "manual" ||
        (current.lastAttemptAt !== null && current.lastAttemptAt >= startedAt)
      ) {
        return false;
      }
      const at = Date.now();
      const delay = failed ? synchronizationRetryDelay(current.failures) : SYNC_DEBOUNCE.pollMs;
      replication.completeAttempt({ at, nextAttemptAt: at + delay, failed });
      return true;
    } finally {
      lock.release();
    }
  }
  try {
    const discovered = await discoverProjectConnection(project.location, request.options, config);
    requireGitExecutionActive();
    if (discovered === null) {
      return { state: "deferred", reason: recordIdleAttempt(false) ? "no-remote" : "busy" };
    }
    if (replication.schedule().mode === "manual") {
      return { state: "deferred", reason: "disabled" };
    }
    return await oneShot({
      directory,
      config: discovered,
      expectedConfiguration: config,
      replication,
      refresh: false,
      id: crypto.randomUUID(),
      timeoutMs: 5000,
      mode: "automatic",
    });
  } catch (error) {
    if (gitExecutionSignal()?.aborted) {
      throw error;
    }
    if (
      error instanceof RelayError &&
      ["GIT_SYNC_WORKER_BUSY", "GIT_SYNC_DEBOUNCED", "PROJECT_CHANGED"].includes(error.code)
    ) {
      return { state: "deferred", reason: "busy" };
    }
    const current = replication.schedule();
    if (current.lastAttemptAt === null || current.lastAttemptAt < startedAt) {
      try {
        recordIdleAttempt(true);
      } catch (recordingError) {
        throw combineProcessFailures(error, recordingError);
      }
    }
    throw error;
  }
}
