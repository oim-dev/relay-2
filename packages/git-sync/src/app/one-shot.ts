import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import {
  combineProcessFailures,
  SYNC_DEBOUNCE,
  synchronizationDueAt,
  synchronizationRetryDelay,
} from "@relay/project-runtime";
import { DataRepository } from "../transport/repository";
import { SyncEngine } from "../sync/engine";
import { ownControl, readEndpoint, responsive } from "../local/control";
import { ControlOperations, operationId } from "../local/operations";
import { operationFailure, waitOperation } from "../local/operation-client";
import { waitUntil } from "../local/deadline";
import { NetworkExchange } from "../sync/network-exchange";
import { syncStatus } from "../sync/status";
import {
  projectRepositoryOptions,
  requireCurrentProject,
  saveDiscoveredConnection,
} from "./project-connection";
import { appMessages } from "./app.messages";
import { submitNetworkOperation } from "./network-operations";
import type { OneShotInput } from "./one-shot.types";
import { requireGitExecutionActive } from "../execution/context";
import { hasSignificantGitFailure } from "../execution/failure";

/**
 * Сохраняет результат только фактически начатой попытки под ещё удерживаемым transport mutex.
 */
function recordAttempt(input: OneShotInput, engine: SyncEngine): void {
  const failed = engine.progress.error !== null;
  const at = Date.now();
  let delay: number = SYNC_DEBOUNCE.pollMs;
  if (failed) {
    delay = synchronizationRetryDelay(input.replication.schedule().failures);
  } else if (engine.progress.publicationWindow?.hasMore) {
    delay = SYNC_DEBOUNCE.continuationMs;
  }
  input.replication.completeAttempt({ at, failed, nextAttemptAt: at + delay });
}

/**
 * Project-local status читает актуальный SQLite mode, включая disable во время уже начатого обмена.
 */
function oneShotStatus(input: OneShotInput, engine: SyncEngine): Promise<unknown> {
  const config = { ...input.config, mode: input.replication.schedule().mode };
  return syncStatus(input.directory, config, input.replication.status(), engine.progress);
}

/**
 * Пытается получить owner без передачи нового project-local now в короткий lifetime чужого auto.
 * Dead endpoint не блокирует перенос каталога; живой чужой endpoint никогда не присваивается.
 * Отмена на границе получения owner не принимает новый operationId; уже опубликованный endpoint закрывается.
 * После settlement значимый terminal отказ своей операции важнее отмены HTTP ожидания; обе причины сохраняются.
 */
async function ownedOneShot(input: OneShotInput, cancellation: AbortController): Promise<unknown> {
  const enteredAt = performance.now();
  const { directory, config, replication, id, refresh, timeoutMs } = input;
  const automatic = input.mode === "automatic";
  const endpointPath = join(directory, "worker.json");
  const endpoint = readEndpoint(endpointPath);
  if (endpoint && (await responsive(endpoint))) {
    if (endpoint.identity !== config.databasePath || endpoint.kind === "supervisor") {
      throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
    }
    if (automatic) {
      return { state: "deferred", reason: "busy" };
    }
    throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
  }
  const repository = new DataRepository(
    projectRepositoryOptions(
      directory,
      config,
      replication.status().replicaId,
      cancellation.signal,
    ),
  );
  const engine = new SyncEngine(
    directory,
    config.projectId,
    replication,
    repository,
    cancellation.signal,
  );
  let exchange: NetworkExchange | undefined;
  let operations: ControlOperations | undefined;
  let attempted = false;
  const owner = await ownControl(
    endpointPath,
    "request",
    config.databasePath,
    async (request) => {
      if (!exchange || !operations) {
        throw new RelayError("GIT_SYNC_NOT_READY", appMessages.notReady, 4);
      }
      if (request.action === "shutdown") {
        cancellation.abort();
        return { stopping: true };
      }
      if (request.action === "operation.get") {
        return operations.get(operationId(request.input.requestId));
      }
      if (request.action === "status" && request.input.refresh !== true) {
        return oneShotStatus(input, engine);
      }
      throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
    },
    async () => {
      if (input.expectedConfiguration !== undefined) {
        await saveDiscoveredConnection(directory, config, input.expectedConfiguration, replication);
      } else {
        requireCurrentProject(directory, config, replication);
      }
      if (automatic && Date.now() < synchronizationDueAt(replication.schedule())) {
        throw new RelayError("GIT_SYNC_DEBOUNCED", appMessages.busy, 4);
      }
    },
  );
  exchange = new NetworkExchange(engine, cancellation.signal, {
    /**
     * Инициализация входит в фактическую операцию, её outcome, deadline и network lease.
     */
    async prepare(_refreshOnly, signal): Promise<void> {
      requireCurrentProject(directory, config, replication);
      if (automatic && Date.now() < synchronizationDueAt(replication.schedule())) {
        throw new RelayError("GIT_SYNC_DEBOUNCED", appMessages.busy, 4);
      }
      attempted = true;
      repository.setAttemptSignal(signal);
      try {
        await repository.initialize();
      } finally {
        repository.setAttemptSignal(null);
      }
    },
  });
  let outcome: PromiseSettledResult<unknown>;
  try {
    requireGitExecutionActive();
    operations = new ControlOperations(directory, owner.endpoint.instance);
    if (automatic) {
      await exchange.run();
      outcome = {
        status: "fulfilled",
        value: { state: "completed", pending: replication.status().pending },
      };
    } else {
      submitNetworkOperation(
        operations,
        exchange,
        replication,
        id,
        refresh ? "status" : "now",
        () => oneShotStatus(input, engine),
      );
      outcome = {
        status: "fulfilled",
        value: await waitOperation(
          directory,
          id,
          Math.max(1, Math.ceil(timeoutMs - (performance.now() - enteredAt))),
          owner.endpoint,
        ),
      };
    }
  } catch (error) {
    outcome = { status: "rejected", reason: error };
  }
  const cleanupDeadline = setTimeout(() => cancellation.abort(), 20_000);
  try {
    operations?.closeAcceptance();
    const own = operations?.get(id);
    if (!automatic && (!own || own.state === "queued" || own.state === "running")) {
      cancellation.abort();
    }
    await exchange.settled();
    await operations?.settled();
    await engine.settled();
    const terminal = operations?.get(id);
    if (!automatic && terminal?.state === "failed") {
      const terminalFailure = operationFailure(terminal);
      if (
        hasSignificantGitFailure(terminalFailure) &&
        (outcome.status === "fulfilled" || !hasSignificantGitFailure(outcome.reason))
      ) {
        outcome = {
          status: "rejected",
          reason:
            outcome.status === "rejected"
              ? combineProcessFailures(terminalFailure, outcome.reason)
              : terminalFailure,
        };
      }
    }
    if (attempted) {
      recordAttempt(input, engine);
    }
  } catch (cleanupError) {
    outcome = {
      status: "rejected",
      reason:
        outcome.status === "rejected"
          ? combineProcessFailures(outcome.reason, cleanupError)
          : cleanupError,
    };
  }
  try {
    await owner.close();
  } catch (closeError) {
    outcome = {
      status: "rejected",
      reason:
        outcome.status === "rejected"
          ? combineProcessFailures(outcome.reason, closeError)
          : closeError,
    };
  } finally {
    clearTimeout(cleanupDeadline);
    cancellation.abort();
  }
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

/**
 * Ожидает mutex только до принятия собственного запроса. Accepted/unknown исход не отправляется повторно.
 * Auto имеет единый deadline, включая worktree; explicit после timeout отменяет только своего owner.
 */
export async function oneShot(input: OneShotInput): Promise<unknown> {
  const deadline = performance.now() + input.timeoutMs;
  const cancellation = new AbortController();
  const timer =
    input.mode === "automatic"
      ? setTimeout(() => cancellation.abort(), input.timeoutMs)
      : undefined;
  try {
    for (;;) {
      try {
        return await ownedOneShot(
          { ...input, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) },
          cancellation,
        );
      } catch (error) {
        if (
          input.mode === "automatic" ||
          !(error instanceof RelayError) ||
          error.details?.requestId !== undefined ||
          !["GIT_SYNC_WORKER_BUSY", "GIT_SYNC_OWNER_CLOSING", "GIT_SYNC_NOT_READY"].includes(
            error.code,
          ) ||
          performance.now() >= deadline
        ) {
          throw error;
        }
        await waitUntil(
          Date.now() + Math.min(50, Math.max(1, deadline - performance.now())),
          cancellation.signal,
        );
      }
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    cancellation.abort();
  }
}
