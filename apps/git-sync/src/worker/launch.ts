import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { appMessages } from "../app/app.messages";
import { controlRequest, readEndpoint, responsive } from "../local/control";
import type { ControlEndpoint } from "../local/control.types";
import type { SyncConfiguration } from "../local/state.types";
import { stateDirectory } from "../local/state";
import { waitUntil } from "../local/deadline";
import { componentCommand } from "../transport/component-command";
import { acquireLocalLock, ProjectDatabase } from "@relay/storage";
import { redact } from "../transport/process";
import { GuardedCommandError, runGuardedCommand } from "@relay/project-runtime";
import type { OwnedWorker } from "./launch.types";

/**
 * Читает лишь ограниченный хвост startup-лога, не загружая целиком историю crash/restart.
 */
function startupReason(path: string): string {
  const file = openSync(path, "r");
  try {
    const size = fstatSync(file).size;
    const bytes = Buffer.alloc(Math.min(size, 8192));
    const count = readSync(file, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return redact(bytes.subarray(0, count).toString("utf8"));
  } finally {
    closeSync(file);
  }
}

/**
 * Единственный владелец persistent workers — supervisor. Каждый worker имеет отдельный strict guardian
 * и stdin lease supervisor; request-component никогда не вызывает этот launcher.
 */
export class WorkerLauncher {
  /* Instance авторитетного supervisor, проверяемый в readiness каждого worker. */
  private readonly instance: string;
  /* Остановка всего supervisor не переписывает desired state проектов. */
  private readonly shutdown: AbortSignal;
  /* Только реально созданные этим supervisor jobs; PID не используется как authority. */
  private readonly workers = new Map<string, OwnedWorker>();
  /* Неясная очистка не превращается в successful service stop. */
  private readonly cleanupFailures: unknown[] = [];

  /**
   * Создаёт локального владельца jobs без запуска детей.
   */
  constructor(instance: string, shutdown: AbortSignal) {
    this.instance = instance;
    this.shutdown = shutdown;
  }

  /**
   * Запускает strict lifetime guardian и ограниченный operational log, сохраняя все окружение S.
   */
  private launch(config: SyncConfiguration): OwnedWorker {
    const database = ProjectDatabase.open(config.databasePath);
    let replicaId: string;
    try {
      if (database.projectId !== config.projectId) {
        throw new RelayError("GIT_PROJECT_MISMATCH", appMessages.incompatible, 4);
      }
      replicaId = database.getReplicationStatus().replicaId;
    } finally {
      database.close();
    }
    const directory = stateDirectory(config.databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const log = openSync(join(directory, "worker.log"), "a", 0o600);
    let size = fstatSync(log).size;
    const limit = 64 * 1024;
    /**
     * Оставляет ограниченный журнал этого worker; потоки не накапливаются весь lifetime в памяти.
     */
    function append(chunk: Uint8Array): void {
      const bytes = Buffer.from(chunk).subarray(-limit);
      if (size + bytes.length > limit) {
        ftruncateSync(log, 0);
        size = 0;
      }
      size += writeSync(log, bytes);
    }
    const worker: OwnedWorker = {
      cancellation: new AbortController(),
      completion: Promise.resolve(),
      failure: null,
      done: false,
    };
    this.workers.set(config.databasePath, worker);
    worker.completion = runGuardedCommand({
      component: componentCommand([]),
      argv: componentCommand([
        "worker",
        "--database",
        config.databasePath,
        "--expected-project",
        config.projectId,
        "--expected-replica",
        replicaId,
        "--home",
        config.home,
        "--supervisor-instance",
        this.instance,
        "--parent-lease",
      ]),
      cwd: config.home,
      env: { ...process.env },
      stdinLease: true,
      timeoutMs: null,
      maxOutputBytes: limit,
      terminationGraceMs: 2000,
      signal: AbortSignal.any([this.shutdown, worker.cancellation.signal]),
      stdout: append,
      stderr: append,
    })
      .then(
        (result) => {
          if (result.code !== 0) {
            worker.failure = new RelayError("GIT_SYNC_NOT_READY", appMessages.notReady, 4, {
              exitCode: result.code,
            });
          }
        },
        (error: unknown) => {
          worker.failure = error;
          if (
            error instanceof GuardedCommandError &&
            ["cleanup", "guardian", "protocol"].includes(error.reason)
          ) {
            this.cleanupFailures.push(error);
          }
        },
      )
      .finally(() => {
        worker.done = true;
        closeSync(log);
        if (this.workers.get(config.databasePath) === worker) {
          this.workers.delete(config.databasePath);
        }
      });
    return worker;
  }

  /**
   * Подтверждает ready текущего S-owned экземпляра; чужой прежний S завершается через его authenticated endpoint.
   */
  async ensure(
    config: SyncConfiguration,
    signal: AbortSignal = this.shutdown,
  ): Promise<ControlEndpoint> {
    const directory = stateDirectory(config.databasePath);
    const path = join(directory, "worker.json");
    const current = readEndpoint(path);
    if (current && (await responsive(current))) {
      if (current.kind === "request") {
        throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
      }
      if (current.identity !== config.databasePath || current.kind !== "worker") {
        throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
      }
      const owned = this.workers.get(config.databasePath);
      if (
        current.supervisorInstance === this.instance &&
        owned &&
        !owned.done &&
        !owned.cancellation.signal.aborted
      ) {
        return current;
      }
      await stopWorker(directory);
    }
    if (signal.aborted || this.shutdown.aborted) {
      throw new RelayError("GIT_CANCELLED", appMessages.notReady, 1);
    }
    const worker = this.workers.get(config.databasePath) ?? this.launch(config);
    const deadline = Date.now() + 12_000;
    try {
      while (Date.now() < deadline && !signal.aborted && !this.shutdown.aborted) {
        const endpoint = readEndpoint(path);
        if (
          endpoint &&
          endpoint.identity === config.databasePath &&
          endpoint.supervisorInstance === this.instance &&
          (await responsive(endpoint))
        ) {
          return endpoint;
        }
        if (worker.done) {
          break;
        }
        await waitUntil(Date.now() + 50, AbortSignal.any([signal, this.shutdown]));
      }
      throw new RelayError("GIT_SYNC_NOT_READY", appMessages.notReady, 4, {
        logPath: join(directory, "worker.log"),
        reason: startupReason(join(directory, "worker.log")),
      });
    } catch (error) {
      worker.cancellation.abort();
      await worker.completion;
      if (
        worker.failure instanceof GuardedCommandError &&
        ["cleanup", "guardian", "protocol"].includes(worker.failure.reason)
      ) {
        throw new RelayError("GIT_SYNC_WORKER_CLEANUP", appMessages.workerCleanup, 1, {
          reason: worker.failure.reason,
        });
      }
      throw error;
    }
  }

  /**
   * Останавливает собственный job без PID heuristics, включая случай утраченного endpoint-файла.
   */
  async stop(
    databasePath: string,
    options: { readonly persistentOnly?: boolean } = {},
  ): Promise<void> {
    const worker = this.workers.get(databasePath);
    if (worker) {
      worker.cancellation.abort();
      await worker.completion;
    }
    if (
      worker?.failure instanceof GuardedCommandError &&
      ["cleanup", "guardian", "protocol"].includes(worker.failure.reason)
    ) {
      throw new RelayError("GIT_SYNC_WORKER_CLEANUP", appMessages.workerCleanup, 1, {
        reason: worker.failure.reason,
      });
    }
    await stopWorker(stateDirectory(databasePath), options);
  }

  /**
   * Завершает все принадлежащие S jobs, не меняя mode/desired регистрации.
   */
  async close(): Promise<void> {
    const workers = [...this.workers.values()];
    for (const worker of workers) {
      worker.cancellation.abort();
    }
    await Promise.allSettled(workers.map((worker) => worker.completion));
    if (this.cleanupFailures.length > 0) {
      throw new RelayError("GIT_SYNC_WORKER_CLEANUP", appMessages.workerCleanup, 1);
    }
  }
}

/**
 * Просит graceful shutdown и ждёт снятия readiness; PID не используется как признак успеха.
 */
export async function stopWorker(
  directory: string,
  options: { readonly persistentOnly?: boolean } = {},
): Promise<void> {
  const path = join(directory, "worker.json");
  const endpoint = readEndpoint(path);
  if (!endpoint) {
    return;
  }
  if (
    endpoint.identity !== directory.slice(0, -".git-sync".length) ||
    endpoint.kind === "supervisor"
  ) {
    throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
  }
  if (options.persistentOnly && endpoint.kind === "request") {
    return;
  }
  if (!(await responsive(endpoint, { compatibleRelease: false }))) {
    try {
      const lock = acquireLocalLock(`${path}.ownership.sqlite`);
      try {
        if (readEndpoint(path)?.instance === endpoint.instance) {
          unlinkSync(path);
        }
      } finally {
        lock.release();
      }
      return;
    } catch (error) {
      if (error instanceof RelayError && error.code === "LOCAL_LOCK_BUSY") {
        throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
      }
      throw error;
    }
  }
  await controlRequest(endpoint, "shutdown");
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const current = readEndpoint(path);
    if (!current || current.instance !== endpoint.instance) {
      return;
    }
    await waitUntil(Date.now() + 50, AbortSignal.timeout(1000));
  }
  throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
}
