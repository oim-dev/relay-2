import { realpathSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { appMessages } from "../app/app.messages";
import { requiredString } from "../app/protocol";
import { ownControl } from "../local/control";
import type { ControlOwner } from "../local/control.types";
import { readConfiguration, stateDirectory } from "../local/state";
import { DataRepository } from "../transport/repository";
import { ReplicationAdapter } from "../sync/replication-adapter";
import { SyncEngine } from "../sync/engine";
import { waitUntil } from "../local/deadline";
import { syncStatus } from "./status";
import { writeLocalJson } from "../local/files";
import { NetworkExchange } from "./network-exchange";
import { openWorkerProject } from "./context";
import type { WorkerOptions } from "./context.types";
import { getConflict, listConflicts, resolveConflictRequest } from "../app/conflicts";
import { ControlOperations, operationId } from "../local/operations";
import { submitNetworkOperation } from "../app/network-operations";

/**
 * Запускает foreground worker одной физической базы до отмены. Готовность публикует после открытия.
 * Capture не ждёт fetch: сетевой цикл async, локальное поколение проверяется отдельным heartbeat.
 */
export async function runWorker(options: WorkerOptions, shutdown: AbortController): Promise<void> {
  const project = openWorkerProject(options);
  let owner: ControlOwner | undefined;
  let engine: SyncEngine | undefined;
  let exchange: NetworkExchange | undefined;
  let operations: ControlOperations | undefined;
  try {
    const directory = stateDirectory(realpathSync(project.location.databasePath));
    const config = readConfiguration(directory);
    if (!config) {
      throw new RelayError("GIT_SYNC_NOT_CONNECTED", appMessages.notConnected, 4);
    }
    const replication = new ReplicationAdapter(project.database);
    const repository = new DataRepository({
      directory: join(directory, "repository"),
      remote: config.remote,
      branch: config.branch,
      signal: shutdown.signal,
    });
    const activeEngine = new SyncEngine(
      directory,
      project.location.projectId,
      replication,
      repository,
      shutdown.signal,
    );
    engine = activeEngine;
    owner = await ownControl(
      join(directory, "worker.json"),
      "worker",
      config.databasePath,
      async (request) => {
        if (!exchange || !operations) {
          throw new RelayError("GIT_SYNC_NOT_READY", appMessages.notReady, 4);
        }
        switch (request.action) {
          case "operation.get":
            return operations.get(operationId(request.input.requestId));
          case "operation.submit": {
            const action = request.input.action;
            if (action !== "now" && action !== "status") {
              throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
            }
            return submitNetworkOperation(
              operations,
              exchange,
              replication,
              request.requestId,
              action,
              () =>
                syncStatus(
                  directory,
                  readConfiguration(directory),
                  replication.status(),
                  activeEngine.progress,
                  owner?.endpoint,
                ),
            );
          }
          case "shutdown":
            setTimeout(() => shutdown.abort(), 0);
            return { stopping: true };
          case "status":
            if (request.input.refresh === true) {
              return submitNetworkOperation(
                operations,
                exchange,
                replication,
                request.requestId,
                "status",
                () =>
                  syncStatus(
                    directory,
                    readConfiguration(directory),
                    replication.status(),
                    activeEngine.progress,
                    owner?.endpoint,
                  ),
              );
            }
            return syncStatus(
              directory,
              readConfiguration(directory),
              replication.status(),
              activeEngine.progress,
              owner?.endpoint,
            );
          case "now":
            return submitNetworkOperation(
              operations,
              exchange,
              replication,
              request.requestId,
              "now",
              () =>
                syncStatus(
                  directory,
                  readConfiguration(directory),
                  replication.status(),
                  activeEngine.progress,
                  owner?.endpoint,
                ),
            );
          case "conflicts.list":
            return listConflicts(replication);
          case "conflicts.get":
            return getConflict(replication, requiredString(request.input.id));
          case "conflicts.resolve":
            return resolveConflictRequest(replication, request.input);
          default:
            throw new RelayError("GIT_SYNC_UNKNOWN_ACTION", appMessages.action, 2);
        }
      },
      () => repository.initialize(),
      options.supervisorInstance,
    );
    exchange = new NetworkExchange(config.home, owner.endpoint, activeEngine, shutdown.signal);
    operations = new ControlOperations(directory, owner.endpoint.instance);
    let capturedVersion: string | null = null;
    let nextNetwork = Date.now() + 500;
    let failures = 0;
    while (!shutdown.signal.aborted) {
      const latest = readConfiguration(directory);
      const local = replication.status();
      const localVersion = `${local.generation}:${local.transportVersion}`;
      if (capturedVersion !== localVersion) {
        writeLocalJson(join(directory, "checkpoint.json"), replication.capture());
        capturedVersion = localVersion;
      }
      if (
        latest?.mode === "auto" &&
        latest.desired === "running" &&
        Date.now() >= nextNetwork &&
        !activeEngine.busy
      ) {
        // Promise остаётся во владении engine; finally shutdown обязательно ждёт settled().
        nextNetwork = Number.POSITIVE_INFINITY;
        activeEngine.progress.nextRetry = null;
        activeEngine.save();
        void exchange.run().then(
          () => {
            failures = 0;
            nextNetwork =
              Date.now() + (activeEngine.progress.publicationWindow?.hasMore ? 500 : 5000);
            activeEngine.progress.nextRetry = new Date(nextNetwork).toISOString();
            activeEngine.save();
          },
          () => {
            failures++;
            const delay =
              Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) * (0.5 + Math.random());
            nextNetwork = Date.now() + delay;
            activeEngine.progress.nextRetry = new Date(nextNetwork).toISOString();
            activeEngine.save();
          },
        );
      }
      if (
        latest?.mode === "manual" &&
        !activeEngine.busy &&
        activeEngine.progress.nextRetry !== null
      ) {
        activeEngine.progress.nextRetry = null;
        activeEngine.save();
      }
      await waitUntil(Date.now() + 500, shutdown.signal).catch((error) => {
        if (!shutdown.signal.aborted) {
          throw error;
        }
      });
    }
  } finally {
    shutdown.abort();
    operations?.closeAcceptance();
    try {
      await exchange?.settled();
      await operations?.settled();
      await engine?.settled();
      if (engine && owner) {
        engine.progress.nextRetry = null;
        engine.progress.phase = "idle";
        engine.save();
      }
    } finally {
      try {
        await owner?.close();
      } finally {
        project.database.close();
      }
    }
  }
}
