import type { ControlEndpoint } from "../local/control.types";
import type { SyncEngine } from "../sync/engine";
import { withNetworkPermit } from "./network-permit";
import { failure } from "../app/errors";
import type { PendingExchange } from "./network-exchange.types";

/**
 * Единственный владелец coalescing. Новый now не присоединяется к уже начатому снимку:
 * он получает successor cycle; одинаковые ещё не начатые запросы разделяют его результат.
 */
export class NetworkExchange {
  /* Домашний каталог общего supervisor. */
  private readonly home: string;
  /* Готовый владелец физической базы. */
  private readonly owner: ControlEndpoint;
  /* Сам engine намеренно не содержит policy очереди. */
  private readonly engine: SyncEngine;
  /* Общая отмена владельца. */
  private readonly signal: AbortSignal;
  /* Не более одного текущего cycle. */
  private active: PendingExchange | null = null;
  /* Не более одного ожидающего read и одного write cycle. */
  private readonly queue: PendingExchange[] = [];

  /**
   * Подключает готового owner к engine без запуска сети.
   */
  constructor(home: string, owner: ControlEndpoint, engine: SyncEngine, signal: AbortSignal) {
    this.home = home;
    this.owner = owner;
    this.engine = engine;
    this.signal = signal;
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
    try {
      for (const started of entry.started) {
        started();
      }
      this.engine.progress.phase = "waiting";
      this.engine.progress.nextRetry = null;
      this.engine.save();
      await withNetworkPermit(this.home, this.owner, this.signal, (signal) =>
        this.engine.run(entry.refreshOnly, signal),
      );
    } catch (error) {
      if (this.engine.progress.phase === "waiting") {
        this.engine.progress.error = {
          ...failure(error).error,
          at: new Date().toISOString(),
          operation: "waiting",
        };
        this.engine.progress.phase = "error";
        this.engine.save();
      }
      throw error;
    }
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
