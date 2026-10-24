import { realpathSync } from "node:fs";
import { RelayError } from "@relay/contracts";
import {
  readConfiguration,
  registerConfiguration,
  stateDirectory,
  updateConfiguration,
} from "../local/state";
import type { SyncConfiguration } from "../local/state.types";
import type { ControlEndpoint } from "../local/control.types";
import { appMessages } from "../app/app.messages";
import { waitUntil } from "../local/deadline";
import type { WorkerLauncher } from "./launch";
import type { PendingProjectStart, ProjectStartOptions } from "./project-control.types";

/**
 * S владеет очередью startup и CAS предпочтений. Отсутствующий/неуспешный запуск не включает auto/desired.
 */
export class ProjectController {
  /* Физический home этого supervisor. */
  private readonly home: string;
  /* Все долгоживущие jobs создаются только этим launcher. */
  private readonly launcher: WorkerLauncher;
  /* Остановка S отменяет ещё не завершённые старты. */
  private readonly shutdown: AbortSignal;
  /* Одна команда startup на базу; reconcile не конкурирует с явным restart. */
  private readonly pending = new Map<string, PendingProjectStart>();
  /* FIFO ожидание ограниченного host startup budget. */
  private readonly waiting: string[] = [];
  /* Количество активных запусков/проверок startup. */
  private active = 0;

  /**
   * Принимает S scope и владельца jobs; ресурсов до команды не создаёт.
   */
  constructor(home: string, launcher: WorkerLauncher, shutdown: AbortSignal) {
    this.home = home;
    this.launcher = launcher;
    this.shutdown = shutdown;
  }

  /**
   * Проверяет локальную регистрацию и её принадлежность этому home, не выполняя предметных writes.
   */
  private configuration(databasePath: string): SyncConfiguration {
    const config = readConfiguration(stateDirectory(databasePath));
    if (!config) {
      throw new RelayError("GIT_SYNC_NOT_CONNECTED", appMessages.notConnected, 4);
    }
    if (config.databasePath !== databasePath || realpathSync(config.home) !== this.home) {
      throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
    }
    return config;
  }

  /**
   * Получает FIFO startup slot; отменённый запрос удаляется из очереди без ghost start.
   */
  private async slot(signal: AbortSignal): Promise<() => void> {
    const ticket = crypto.randomUUID();
    this.waiting.push(ticket);
    try {
      while (this.active >= 4 || this.waiting[0] !== ticket) {
        await waitUntil(Date.now() + 25, signal);
      }
      if (signal.aborted) {
        throw new RelayError("GIT_CANCELLED", appMessages.notReady);
      }
      this.waiting.shift();
      this.active++;
      return () => {
        this.active--;
      };
    } catch (error) {
      const index = this.waiting.indexOf(ticket);
      if (index >= 0) {
        this.waiting.splice(index, 1);
      }
      throw error;
    }
  }

  /**
   * Запускает/перезапускает W и только после readiness публикует auto/desired под CAS.
   */
  start(
    databasePath: string,
    options: ProjectStartOptions,
    caller: AbortSignal,
  ): Promise<ControlEndpoint> {
    const signature = JSON.stringify(options);
    const initial = this.configuration(databasePath);
    const previous = this.pending.get(databasePath);
    if (previous) {
      if (previous.signature === signature) {
        return previous.promise.then((endpoint) => {
          if (!endpoint) {
            throw new RelayError("GIT_SYNC_CONTROL_CHANGED", appMessages.controlChanged, 4);
          }
          return endpoint;
        });
      }
      if (previous.signature === "reconcile") {
        return previous.promise.then(() => {
          if (this.configuration(databasePath).controlRevision !== initial.controlRevision) {
            throw new RelayError("GIT_SYNC_CONTROL_CHANGED", appMessages.controlChanged, 4);
          }
          return this.start(databasePath, options, caller);
        });
      }
      return Promise.reject(
        new RelayError("GIT_SYNC_CONTROL_CHANGED", appMessages.controlChanged, 4),
      );
    }
    const signal = AbortSignal.any([caller, this.shutdown, AbortSignal.timeout(20_000)]);
    const promise = this.performStart(initial, options, signal).finally(() => {
      this.pending.delete(databasePath);
    });
    this.pending.set(databasePath, { signature, promise });
    return promise;
  }

  /**
   * Исполняет одну команду; stop/disable с новой controlRevision не перезаписываются старым стартом.
   */
  private async performStart(
    initial: SyncConfiguration,
    options: ProjectStartOptions,
    signal: AbortSignal,
  ): Promise<ControlEndpoint> {
    const release = await this.slot(signal);
    try {
      const current = this.configuration(initial.databasePath);
      if (current.controlRevision !== initial.controlRevision) {
        throw new RelayError("GIT_SYNC_CONTROL_CHANGED", appMessages.controlChanged, 4);
      }
      if (options.restart) {
        await this.launcher.stop(initial.databasePath);
      }
      const endpoint = await this.launcher.ensure(current, signal);
      const updated = updateConfiguration(stateDirectory(initial.databasePath), (latest) => {
        if (signal.aborted || !latest || latest.controlRevision !== initial.controlRevision) {
          throw new RelayError("GIT_SYNC_CONTROL_CHANGED", appMessages.controlChanged, 4);
        }
        return { ...latest, mode: options.mode ?? latest.mode, desired: "running" };
      });
      registerConfiguration(updated);
      return endpoint;
    } catch (error) {
      if (this.configuration(initial.databasePath).desired === "stopped") {
        await this.launcher.stop(initial.databasePath);
      }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Stop фиксирует намерение раньше отмены job; не требует successful readiness worker.
   */
  async stop(databasePath: string): Promise<void> {
    this.configuration(databasePath);
    updateConfiguration(stateDirectory(databasePath), (latest) => {
      if (!latest) {
        throw new RelayError("GIT_SYNC_NOT_CONNECTED", appMessages.notConnected, 4);
      }
      return { ...latest, desired: "stopped" };
    });
    await this.launcher.stop(databasePath, { persistentOnly: true });
  }

  /**
   * Восстанавливает сохранённый desired без изменения preferences; явный startup имеет приоритет.
   */
  async reconcile(databasePath: string): Promise<ControlEndpoint | null> {
    if (this.pending.has(databasePath)) {
      return null;
    }
    const config = this.configuration(databasePath);
    if (config.desired === "stopped") {
      await this.launcher.stop(databasePath, { persistentOnly: true });
      return null;
    }
    const promise = this.reconcileRunning(config).finally(() => {
      this.pending.delete(databasePath);
    });
    this.pending.set(databasePath, { signature: "reconcile", promise });
    return promise;
  }

  /**
   * Background startup делит тот же бюджет с RPC и не меняет пользовательские предпочтения.
   */
  private async reconcileRunning(config: SyncConfiguration): Promise<ControlEndpoint | null> {
    const release = await this.slot(this.shutdown);
    try {
      const endpoint = await this.launcher.ensure(config, this.shutdown);
      if (this.configuration(config.databasePath).desired === "stopped") {
        await this.launcher.stop(config.databasePath);
        return null;
      }
      return endpoint;
    } finally {
      release();
    }
  }

  /**
   * Прекращает owned jobs и ждёт завершения startup без изменения desired.
   */
  async close(): Promise<void> {
    await this.launcher.close();
    await Promise.allSettled([...this.pending.values()].map((entry) => entry.promise));
  }
}
