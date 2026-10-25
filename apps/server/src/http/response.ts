import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { httpMessages } from "./http.messages";

/**
 * Создаёт Fetch head для policy/static; неверный Host остаётся в headers для явного отказа guard.
 */
export function fetchHead(request: FastifyRequest, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const url = new URL(request.url, "http://localhost");
  url.host = headers.get("host") ?? "localhost";
  return new Request(url, { method: request.method, headers, ...(signal ? { signal } : {}) });
}

/**
 * Привязывает отмену Web stream к закрытию HTTP-ответа, а не к концу чтения request body.
 */
export function responseSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  /**
   * Освобождает оба сетевых listener при разрыве клиента или нормальном окончании ответа.
   */
  const abort = (): void => {
    request.raw.off("aborted", abort);
    reply.raw.off("close", abort);
    controller.abort();
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  if (request.raw.aborted || reply.raw.destroyed) {
    abort();
  }
  return controller.signal;
}

/**
 * Передаёт Web bytes с backpressure Node. Destroy немедленно отменяет также pending read,
 * в отличие от async-generator return, который мог бы ждать следующий бесконечный chunk.
 */
function nodeResponseBody(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();
  return new Readable({
    objectMode: false,
    /**
     * Node запрашивает следующий chunk только после освобождения своей очереди.
     */
    read(): void {
      void reader.read().then(
        (chunk) => {
          if (!this.destroyed) {
            this.push(chunk.done ? null : chunk.value);
          }
        },
        (cause: unknown) =>
          this.destroy(
            cause instanceof Error ? cause : new Error(httpMessages.internal, { cause }),
          ),
      );
    },
    /**
     * Disconnect/нормальное завершение освобождают Web reader, включая ожидающее чтение.
     */
    destroy(error, done): void {
      void reader.cancel(error).then(
        () => {
          reader.releaseLock();
          done(error);
        },
        (cause: unknown) => {
          reader.releaseLock();
          done(cause instanceof Error ? cause : new Error(httpMessages.internal, { cause }));
        },
      );
    },
  });
}

/**
 * Передаёт Response status, headers и bytes в Fastify без буферизации Web/SSE потока.
 * Disconnect уничтожает Node stream, вызывая cancel исходного Web reader. HEAD тела не читает.
 */
export async function sendResponse(
  response: Response,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, key) => {
    if (key === "vary") {
      const previous = reply.getHeader("vary");
      const fields = [...String(previous ?? "").split(","), ...value.split(",")];
      reply.header(
        key,
        [...new Set(fields.map((field) => field.trim()).filter(Boolean))].join(", "),
      );
    } else {
      reply.header(key, value);
    }
  });
  if (request.method === "HEAD" || response.body === null) {
    await response.body?.cancel();
    reply.send();
    return;
  }
  const stream = nodeResponseBody(response.body);
  reply.raw.once("close", () => stream.destroy());
  reply.send(stream);
}
