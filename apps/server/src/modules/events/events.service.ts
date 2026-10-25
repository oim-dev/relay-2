import { Inject, Injectable } from "@nestjs/common";
import { RelayError, type HttpProjectEvent } from "@relay/contracts";
import type { RelayServerOptions } from "../../server.types";
import { SERVER_OPTIONS } from "../../http/options";
import { httpMessages } from "../../http/http.messages";
import { publicError } from "../../http/errors";
import { ProjectsService } from "../projects/projects.service";
import type {
  EventSubscriber,
  ProjectNotification,
  ProjectWatch,
  SubscribeProjectEvents,
} from "./events.types";

/**
 * Сохраняет последнее уведомление каждого типа в порядке наблюдения; connected не заменяется.
 * Changed и storage-error удаляют устаревший heartbeat. Heartbeat после changed избыточен,
 * но после ошибки сохраняется как наблюдение восстановления. Максимум — четыре события.
 */
function coalesceNotification(pending: HttpProjectEvent[], event: ProjectNotification): void {
  if (event.type === "heartbeat" && pending.at(-1)?.type === "changed") {
    return;
  }
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (
      pending[index]?.type === event.type ||
      (event.type !== "heartbeat" && pending[index]?.type === "heartbeat")
    ) {
      pending.splice(index, 1);
    }
  }
  pending.push(event);
}

/**
 * Создаёт bounded invalidation stream: без Web prefetch и без сериализации до pull.
 * Хранит connected и не более одного непрочитанного события каждого poll-типа; общий watcher
 * не ждёт медленного клиента. Cancel/abort/stop отписываются один раз и отбрасывают очередь.
 * Последнее поколение изменённого проекта сохраняется; reconnect начинает новый connected.
 */
export function createEventStream(
  projectId: string,
  generation: number,
  signal: AbortSignal,
  subscribe: SubscribeProjectEvents,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pending: HttpProjectEvent[] = [{ type: "connected", projectId, generation }];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ended = false;
  let requested = false;
  /**
   * До синхронного start подписка ещё не приобретена.
   */
  let unsubscribe = (): void => {};
  /**
   * Выдаёт ровно один кадр на потребительский pull, не создавая собственной byte-очереди.
   */
  function flush(): void {
    if (ended || !requested || controller === undefined) {
      return;
    }
    const event = pending.shift();
    if (event !== undefined) {
      requested = false;
      controller.enqueue(
        encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      );
    }
  }
  /**
   * Освобождает watcher, abort listener и непрочитанные данные независимо от причины завершения.
   */
  function cancel(): void {
    if (!ended) {
      ended = true;
      requested = false;
      pending.length = 0;
      signal.removeEventListener("abort", stop);
      unsubscribe();
    }
  }
  /**
   * Завершает ожидающий reader при shutdown/abort; после cancel повторно stream не закрывается.
   */
  function stop(): void {
    if (!ended) {
      cancel();
      controller?.close();
    }
  }
  return new ReadableStream<Uint8Array>(
    {
      /**
       * Присоединяет ровно одного consumer к общему watcher без отправки до pull.
       */
      start(output): void {
        controller = output;
        unsubscribe = subscribe({
          stop,
          /**
           * Объединяет непрочитанные уведомления, сохраняя исходный connected и последнюю диагностику.
           */
          send(event): void {
            if (!ended) {
              coalesceNotification(pending, event);
              flush();
            }
          },
        });
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) {
          stop();
        }
      },
      /**
       * Фиксирует спрос reader; если событий нет, последующий send удовлетворит этот pull.
       */
      pull(): void {
        requested = true;
        flush();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
}

/**
 * Общий SSE watcher проектов: только generation, без загрузки сущностей/графа задач.
 * Владеет таймерами, Web stream subscriptions и уже начатыми poll.
 */
@Injectable()
export class EventsService {
  /* Один watcher на projectId, пока есть подписчики. */
  private readonly watches = new Map<string, ProjectWatch>();
  /* Начатые poll сохраняются даже после отмены последней подписки. */
  private readonly pending = new Set<Promise<void>>();
  /* Запрет нового stream после запроса shutdown. */
  private closing = false;

  /**
   * Получает владельца generation и явные интервалы наблюдения.
   */
  constructor(
    /* Владелец узких generation чтений и проверки физического anchor. */
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    /* Явные интервалы watcher и heartbeat этого сервера. */
    @Inject(SERVER_OPTIONS) private readonly options: RelayServerOptions,
  ) {}

  /**
   * Проверяет проект до отправки headers; ошибки открытия остаются обычным JSON envelope.
   */
  async response(projectId: string, signal: AbortSignal): Promise<Response> {
    const generation = await this.projects.run(projectId, (db) => db.getGeneration());
    if (this.closing) {
      throw new RelayError("SERVER_CLOSING", httpMessages.closing);
    }
    const stream = createEventStream(projectId, generation, signal, (subscriber) =>
      this.subscribe(projectId, generation, subscriber),
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  /**
   * Присоединяет подписчика и возвращает его отписку; последний освобождает timer.
   */
  private subscribe(
    projectId: string,
    generation: number,
    subscriber: EventSubscriber,
  ): () => void {
    let watch = this.watches.get(projectId);
    if (watch === undefined) {
      const timer = setInterval(() => {
        const current = this.watches.get(projectId);
        if (current === undefined || current.busy) {
          return;
        }
        current.busy = true;
        const polling = this.poll(projectId, current).finally(() => {
          current.busy = false;
          this.pending.delete(polling);
        });
        this.pending.add(polling);
      }, this.options.eventIntervalMs ?? 1000);
      watch = { timer, generation, timestamp: Date.now(), busy: false, subscribers: new Set() };
      this.watches.set(projectId, watch);
    }
    watch.subscribers.add(subscriber);
    return () => {
      watch.subscribers.delete(subscriber);
      if (watch.subscribers.size === 0) {
        clearInterval(watch.timer);
        if (this.watches.get(projectId) === watch) {
          this.watches.delete(projectId);
        }
      }
    };
  }

  /**
   * Замечает commits CLI/Git Sync узким чтением и не подменяет Storage отказ heartbeat.
   */
  private async poll(projectId: string, watch: ProjectWatch): Promise<void> {
    try {
      const generation = await this.projects.run(projectId, (db) => db.getGeneration());
      const changed = watch.generation !== generation;
      if (changed || Date.now() - watch.timestamp >= (this.options.heartbeatIntervalMs ?? 15000)) {
        watch.generation = generation;
        watch.timestamp = Date.now();
        for (const subscriber of watch.subscribers) {
          subscriber.send({ type: changed ? "changed" : "heartbeat", projectId, generation });
        }
      }
    } catch (error) {
      for (const subscriber of watch.subscribers) {
        subscriber.send({
          type: "storage-error",
          projectId,
          generation: watch.generation,
          error: publicError(error),
        });
      }
    }
  }

  /**
   * Прекращает SSE до ожидания listener и завершает все уже начатые poll.
   */
  async close(): Promise<void> {
    this.closing = true;
    for (const watch of this.watches.values()) {
      clearInterval(watch.timer);
      for (const subscriber of [...watch.subscribers]) {
        subscriber.stop();
      }
    }
    this.watches.clear();
    await Promise.allSettled([...this.pending]);
  }
}
