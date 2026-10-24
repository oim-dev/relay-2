import type { GitSyncNetworkLeaseEvent } from "@relay/contracts";
import type { NetworkLease } from "./network-leases.types";

/**
 * FIFO host budget, удерживаемый HTTP stream. Потеря клиента немедленно освобождает queued/granted слот.
 */
export class NetworkLeases {
  /* Живые соединения в порядке принятия. */
  private readonly leases = new Map<string, NetworkLease>();
  /* Одновременно исполняющиеся проекты. */
  private active = 0;

  /**
   * Возвращает фактическое число granted соединений.
   */
  get size(): number {
    return this.active;
  }

  /**
   * Число живых ожидающих соединений для диагностики FIFO.
   */
  get queued(): number {
    return this.leases.size - this.active;
  }

  /**
   * Принимает request stream без определения liveness по PID/mtime/endpoint existence.
   */
  open(requestId: string, signal: AbortSignal): Response {
    const id = crypto.randomUUID();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const lease: NetworkLease = {
          id,
          requestId,
          stream: controller,
          granted: false,
          signal,
          abort: () => this.release(id),
        };
        this.leases.set(id, lease);
        signal.addEventListener("abort", lease.abort, { once: true });
        if (signal.aborted) {
          this.release(id);
          return;
        }
        this.send(lease, "queued");
        this.promote();
      },
      cancel: () => this.release(id),
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  }

  /**
   * Передаёт только control metadata; failure writer снимает его lease.
   */
  private send(lease: NetworkLease, state: GitSyncNetworkLeaseEvent["state"]): void {
    const event: GitSyncNetworkLeaseEvent = {
      version: 1,
      leaseId: lease.id,
      requestId: lease.requestId,
      state,
    };
    try {
      lease.stream.enqueue(Buffer.from(JSON.stringify(event) + "\n"));
    } catch {
      this.release(lease.id);
    }
  }

  /**
   * Освобождает одно соединение и продвигает следующего FIFO участника.
   */
  private release(id: string): void {
    const lease = this.leases.get(id);
    if (!lease) {
      return;
    }
    this.leases.delete(id);
    lease.signal.removeEventListener("abort", lease.abort);
    if (lease.granted) {
      this.active--;
    }
    try {
      lease.stream.close();
    } catch {
      /* EOF уже закрыл writer. */
    }
    this.promote();
  }

  /**
   * Выдаёт свободные места только живым соединениям, не перескакивая очередь.
   */
  private promote(): void {
    for (const lease of this.leases.values()) {
      if (this.active >= 4) {
        return;
      }
      if (!lease.granted) {
        lease.granted = true;
        this.active++;
        this.send(lease, "granted");
      }
    }
  }

  /**
   * Закрытие S даёт EOF всем клиентам; они отменяют выполняющиеся Git attempts.
   */
  close(): void {
    for (const lease of this.leases.values()) {
      lease.signal.removeEventListener("abort", lease.abort);
      try {
        lease.stream.close();
      } catch {
        /* Клиент мог закрыть pipe раньше S. */
      }
    }
    this.leases.clear();
    this.active = 0;
  }
}
