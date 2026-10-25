import { Injectable } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import { fetchHead, responseSignal } from "./response";
import { httpMessages } from "./http.messages";

/**
 * Передаёт исходные Node bytes в Web reader без eager buffering и смены кодировки.
 * Cancel возвращает iterator без destroy и дренирует вход, оставляя socket для JSON отказа.
 */
function webBody(source: IncomingMessage): ReadableStream<Uint8Array> {
  const iterator = source.iterator({ destroyOnReturn: false });
  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        const chunk = await iterator.next();
        if (chunk.done) {
          controller.close();
        } else if (chunk.value instanceof Uint8Array) {
          controller.enqueue(chunk.value);
        } else {
          controller.error(new TypeError(httpMessages.internal));
        }
      },
      cancel: async () => {
        await iterator.return?.();
        source.resume();
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Per-application адаптер исходного запроса, общий для controlHandler и JSON pipe.
 * Слабые ключи не удерживают завершённые requests; fallback не теряет предварительно прочитанный chunk.
 */
@Injectable()
export class RequestAdapter {
  /* Один Fetch request на один native request; body не копируется между handlers. */
  private readonly requests = new WeakMap<FastifyRequest, Request>();

  /**
   * Создаёт потоковый Fetch request при первом обращении, без преобразования JSON или byte body.
   */
  get(request: FastifyRequest, reply?: FastifyReply): Request {
    let adapted = this.requests.get(request);
    if (adapted === undefined) {
      const head = fetchHead(
        request,
        reply === undefined ? undefined : responseSignal(request, reply),
      );
      adapted =
        request.method === "GET" || request.method === "HEAD"
          ? head
          : new Request(head, { body: webBody(request.raw) });
      this.requests.set(request, adapted);
    }
    return adapted;
  }
}
