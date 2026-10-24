import { realpathSync } from "node:fs";
import { join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import { openProject, type OpenedProject } from "@relay/project-runtime";
import { DataRepository } from "../transport/repository";
import { validateBranch } from "../transport/git";
import { transportMessages } from "../transport/transport.messages";
import { ReplicationAdapter } from "../sync/replication-adapter";
import { SyncEngine } from "../sync/engine";
import {
  configuration,
  readConfiguration,
  registerConfiguration,
  stateDirectory,
  updateConfiguration,
} from "../local/state";
import type { SyncConfiguration } from "../local/state.types";
import { ownControl, readEndpoint, responsive } from "../local/control";
import { stopWorker } from "../worker/launch";
import { syncStatus, workerStatus } from "../worker/status";
import { getConflict, listConflicts, resolveConflictRequest } from "./conflicts";
import { appMessages } from "./app.messages";
import { requiredString } from "./protocol";
import { absoluteRemote, restore, savedConnection } from "./restore";
import {
  startSupervisedWorker,
  stopSupervisedWorker,
  supervisorControl,
} from "./supervisor-control";
import { NetworkExchange } from "../worker/network-exchange";
import { DEFAULT_DATA_BRANCH } from "../local/state.constants";
import { ControlOperations, operationId } from "../local/operations";
import {
  getOperation,
  operationWait,
  submitOperation,
  waitOperation,
} from "../local/operation-client";
import { submitNetworkOperation } from "./network-operations";

/**
 * Требует явное подключение; отсутствие не превращается в несуществующий пустой remote.
 */
function connected(config: SyncConfiguration | null): SyncConfiguration {
  if (!config) {
    throw new RelayError("GIT_SYNC_NOT_CONNECTED", appMessages.notConnected, 4);
  }
  return config;
}

/**
 * Выполняет один ручной сетевой цикл при отсутствии persistent worker, сериализуя его тем же owner.
 * Одновременные клиенты уже готового owner используют его IPC; shutdown не повторяет мутацию.
 */
async function oneShot(
  directory: string,
  config: SyncConfiguration,
  replication: ReplicationAdapter,
  refresh: boolean,
  id: string,
  timeoutMs: number,
): Promise<unknown> {
  const endpointPath = join(directory, "worker.json");
  const endpoint = readEndpoint(endpointPath);
  if (endpoint && (endpoint.identity !== config.databasePath || endpoint.kind === "supervisor")) {
    throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
  }
  if (endpoint && (await responsive(endpoint))) {
    await submitOperation(endpoint, id, refresh ? "status" : "now");
    return waitOperation(directory, id, timeoutMs, endpoint);
  }
  const cancellation = new AbortController();
  const repository = new DataRepository({
    directory: join(directory, "repository"),
    remote: config.remote,
    branch: config.branch,
    signal: cancellation.signal,
  });
  const engine = new SyncEngine(
    directory,
    config.projectId,
    replication,
    repository,
    cancellation.signal,
  );
  let exchange: NetworkExchange | undefined;
  let operations: ControlOperations | undefined;
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
      if (request.action === "operation.submit" || request.action === "now") {
        const action = request.action === "now" ? "now" : request.input.action;
        if (action !== "now" && action !== "status") {
          throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
        }
        return submitNetworkOperation(
          operations,
          exchange,
          replication,
          request.requestId,
          action,
          () => syncStatus(directory, config, replication.status(), engine.progress),
        );
      } else if (request.action === "status") {
        if (request.input.refresh === true) {
          return submitNetworkOperation(
            operations,
            exchange,
            replication,
            request.requestId,
            "status",
            () => syncStatus(directory, config, replication.status(), engine.progress),
          );
        }
      } else {
        throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
      }
      return syncStatus(directory, config, replication.status(), engine.progress);
    },
    () => repository.initialize(),
  );
  exchange = new NetworkExchange(config.home, owner.endpoint, engine, cancellation.signal);
  try {
    operations = new ControlOperations(directory, owner.endpoint.instance);
    submitNetworkOperation(operations, exchange, replication, id, refresh ? "status" : "now", () =>
      syncStatus(directory, config, replication.status(), engine.progress),
    );
    return await waitOperation(directory, id, timeoutMs, owner.endpoint);
  } finally {
    operations?.closeAcceptance();
    const own = operations?.get(id);
    if (!own || own.state === "queued" || own.state === "running") {
      cancellation.abort();
    }
    const timer = setTimeout(() => cancellation.abort(), 20_000);
    try {
      await exchange.settled();
      await operations?.settled();
      await engine.settled();
    } finally {
      clearTimeout(timer);
      cancellation.abort();
      await owner.close();
    }
  }
}

/**
 * Подключает проект к одной общей ветке после fetch/validation, без публикации пользовательских данных.
 */
async function connect(
  request: GitSyncRequest,
  directory: string,
  initial: SyncConfiguration,
  replication: ReplicationAdapter,
): Promise<SyncConfiguration> {
  const existing = readConfiguration(directory);
  if (existing && (existing.remote !== initial.remote || existing.branch !== initial.branch)) {
    throw new RelayError("GIT_ORIGIN_MISMATCH", transportMessages.originMismatch, 4);
  }
  if (existing) {
    return existing;
  }
  await validateBranch(request.options.cwd, initial.branch);
  const owner = await ownControl(
    join(directory, "worker.json"),
    "request",
    initial.databasePath,
    async () => {
      throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
    },
  );
  try {
    const repository = new DataRepository({
      directory: join(directory, "repository"),
      remote: initial.remote,
      branch: initial.branch,
    });
    await repository.initialize();
    const engine = new SyncEngine(
      directory,
      initial.projectId,
      replication,
      repository,
      new AbortController().signal,
    );
    await new NetworkExchange(
      initial.home,
      owner.endpoint,
      engine,
      new AbortController().signal,
    ).run(true);
    const result = updateConfiguration(directory, () => initial);
    registerConfiguration(result);
    return result;
  } finally {
    await owner.close();
  }
}

/**
 * Исполняет проверенный процессный запрос; lifecycle соединения всегда ограничен этим вызовом.
 * Пользовательское представление и системные службы остаются в основной CLI/Runtime.
 */
export async function executeAction(request: GitSyncRequest): Promise<unknown> {
  if (request.action === "supervisor.status" || request.action === "supervisor.stop") {
    return supervisorControl(request.action, request.options);
  }
  if (request.action === "restore") {
    return restore(request);
  }
  const actions = [
    "connect",
    "status",
    "now",
    "auto.enable",
    "auto.disable",
    "worker.start",
    "worker.stop",
    "worker.restart",
    "conflicts.list",
    "conflicts.get",
    "conflicts.resolve",
    "request.get",
  ];
  if (!actions.includes(request.action)) {
    throw new RelayError("GIT_SYNC_UNKNOWN_ACTION", appMessages.action, 2);
  }
  let project: OpenedProject;
  try {
    project = openProject(request.options);
  } catch (error) {
    if (!(
      request.action === "worker.stop" &&
      error instanceof RelayError &&
      error.code === "DATABASE_NOT_FOUND"
    )) {
      throw error;
    }
    const previous = connected(savedConnection(request.options));
    const directory = stateDirectory(previous.databasePath);
    const config = updateConfiguration(directory, (current) => ({
      ...connected(current),
      desired: "stopped",
    }));
    if (!(await stopSupervisedWorker(config))) {
      await stopWorker(directory, { persistentOnly: true });
    }
    return {
      projectId: config.projectId,
      mode: config.mode,
      worker: await workerStatus(join(directory, "worker.json"), "stopped"),
      pending: null,
      nextRetry: null,
      database: { available: false, code: "DATABASE_NOT_FOUND" },
    };
  }
  const directory = stateDirectory(realpathSync(project.location.databasePath));
  const input = request.input ?? {};
  const replication = new ReplicationAdapter(project.database);
  try {
    let config = readConfiguration(directory);
    switch (request.action) {
      case "request.get":
        return await getOperation(directory, operationId(input.requestId ?? input.id));
      case "connect": {
        const remote = await absoluteRemote(request.options, requiredString(input.remote));
        const branch =
          input.branch === undefined ? DEFAULT_DATA_BRANCH : requiredString(input.branch);
        config = await connect(
          request,
          directory,
          configuration(project.location, request.options, remote, branch),
          replication,
        );
        break;
      }
      case "status":
        if (input.refresh !== undefined && typeof input.refresh !== "boolean") {
          throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
        }
        if (input.refresh === true) {
          if (input.requestId !== undefined) {
            return await waitOperation(
              directory,
              operationId(input.requestId),
              operationWait(input.waitMs),
            );
          }
          return await oneShot(
            directory,
            connected(config),
            replication,
            true,
            operationId(input.operationId ?? crypto.randomUUID()),
            operationWait(input.waitMs),
          );
        }
        break;
      case "now":
        if (input.requestId !== undefined) {
          return await waitOperation(
            directory,
            operationId(input.requestId),
            operationWait(input.waitMs),
          );
        }
        return await oneShot(
          directory,
          connected(config),
          replication,
          false,
          operationId(input.operationId ?? crypto.randomUUID()),
          operationWait(input.waitMs),
        );
      case "auto.enable":
      case "worker.start":
      case "worker.restart": {
        await startSupervisedWorker(connected(config), {
          ...(request.action === "auto.enable" ? { mode: "auto" as const } : {}),
          ...(request.action === "worker.restart" ? { restart: true } : {}),
        });
        config = connected(readConfiguration(directory));
        break;
      }
      case "auto.disable":
      case "worker.stop": {
        connected(config);
        config = updateConfiguration(directory, (current) => {
          const latest = connected(current);
          let mode = latest.mode;
          let desired = latest.desired;
          if (request.action === "auto.disable") {
            mode = "manual";
          } else {
            desired = "stopped";
          }
          return { ...latest, mode, desired };
        });
        registerConfiguration(config);
        if (request.action === "worker.stop") {
          if (!(await stopSupervisedWorker(config))) {
            await stopWorker(directory, { persistentOnly: true });
          }
        }
        break;
      }
      case "conflicts.list":
        return listConflicts(replication);
      case "conflicts.get":
        return getConflict(replication, requiredString(input.id));
      case "conflicts.resolve":
        return resolveConflictRequest(replication, input);
    }
    const localStatus = replication.status();
    const status = {
      ...(await syncStatus(directory, config, localStatus)),
      projectId: project.location.projectId,
    };
    return status;
  } finally {
    project.database.close();
  }
}
