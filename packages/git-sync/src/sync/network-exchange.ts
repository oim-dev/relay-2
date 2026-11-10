import type { SyncEngine } from "./engine";
import { gitExecutionSignal } from "../execution/context";
import { failure } from "../app/errors";
import type { NetworkExchangeOptions, PendingExchange } from "./network-exchange.types";
import { RelayError } from "@relay/contracts";
import { transportMessages } from "../transport/transport.messages";

/**
 * Единственный владелец coalescing. Новый now не присоединяется к уже начатому снимку:
 * он получает successor cycle; одинаковые ещё не начатые запросы разделяют его результат.
 */
export class NetworkExchange {
  /* Сам engine намеренно не содержит policy очереди. */
  private readonly engine: SyncEngine;
  /* Общая отмена владельца. */
  private readonly signal: AbortSignal;
  /* Подготовка Git принадлежит тому же lease, но не выполняется у cached outcome. */
  private readonly prepare: NetworkExchangeOptions["prepare"];
  /* Не более одного текущего cycle. */
  private active: PendingExchange | null = null;
  /* Не более одного ожидающего read и одного write cycle. */
  private readonly queue: PendingExchange[] = [];

  /**
   * Подключает готового owner к engine без запуска сети.
   */
  constructor(engine: SyncEngine, signal: AbortSignal, options: NetworkExchangeOptions = {}) {
    this.engine = engine;
    this.signal = gitExecutionSignal(signal) ?? signal;
    this.prepare = options.prepare;
  }

  /**
   * Сохраняет порядок read/write запросов; поздний now выполняется после активного цикла.
   */
  run(refreshOnly = false, started?: () => void): Promise<void> {
    const pending = this.queue.find((entry) => entry.refreshOnly === refreshOnly);
    if (pending) {
      if (started) {
        pending.started.push(started);
      }
      return pending.promise;
    }
    const deferred = Promise.withResolvers<void>();
    const entry: PendingExchange = {
      refreshOnly,
      promise: deferred.promise,
      resolve: deferred.resolve,
      reject: deferred.reject,
      started: started ? [started] : [],
    };
    this.queue.push(entry);
    this.drain();
    return entry.promise;
  }

  /**
   * Запускает следующий cycle после завершения предыдущего lease, без второй очереди в engine.
   */
  private drain(): void {
    if (this.active) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.active = next;
    void this.execute(next)
      .then(next.resolve, next.reject)
      .finally(() => {
        this.active = null;
        this.drain();
      });
  }

  /**
   * Отмечает фактический старт и передаёт потерю budget lease в Git cancellation.
   */
  private async execute(entry: PendingExchange): Promise<void> {
    const previousPhase = this.engine.progress.phase;
    const previousError = this.engine.progress.error;
    try {
      for (const started of entry.started) {
        started();
      }
      this.engine.progress.phase = "waiting";
      this.engine.progress.nextRetry = null;
      this.engine.save();
      await this.executeCycle(entry.refreshOnly, this.signal);
    } catch (error) {
      if (this.engine.progress.phase === "waiting") {
        if (error instanceof RelayError && error.code === "GIT_SYNC_DEBOUNCED") {
          this.engine.progress.phase = previousPhase;
          this.engine.progress.error = previousError;
        } else {
          this.engine.progress.error = {
            ...failure(error).error,
            at: new Date().toISOString(),
            operation: "waiting",
          };
          this.engine.progress.phase = "error";
        }
        this.engine.save();
      }
      throw error;
    }
  }

  /**
   * Подготавливает и выполняет cycle под одним живым budget lease; отменённая очередь не начинает Git.
   */
  private async executeCycle(refreshOnly: boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new RelayError("GIT_CANCELLED", transportMessages.aborted, 1);
    }
    await this.prepare?.(refreshOnly, signal);
    await this.engine.run(refreshOnly, signal);
  }

  /**
   * Shutdown ждёт также отменённых queued successors до закрытия БД/endpoint.
   */
  async settled(): Promise<void> {
    while (this.active || this.queue.length > 0) {
      const promises = [this.active?.promise, ...this.queue.map((entry) => entry.promise)].filter(
        (value) => value !== undefined,
      );
      await Promise.allSettled(promises);
      await Promise.resolve();
    }
  }
}
