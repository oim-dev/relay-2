import {
  createParamDecorator,
  Injectable,
  Inject,
  type ExecutionContext,
  type PipeTransform,
} from "@nestjs/common";
import { RelayError } from "@relay/contracts";
import type { FastifyRequest } from "fastify";
import { httpMessages } from "./http.messages";
import { RequestAdapter } from "./request-adapter";

/**
 * Лимит транспортного тела; предметные ограничения независимо проверяет Core.
 */
export const HTTP_BODY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Проверяет форму JSON объекта на непроверенной границе.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Передаёт сырой Fastify request в pipe, чтобы framework не менял JSON и не буферизовал body.
 */
export const RawBody = createParamDecorator(
  (_data: unknown, context: ExecutionContext): FastifyRequest =>
    context.switchToHttp().getRequest<FastifyRequest>(),
);

/**
 * Единственный reader JSON: строгий UTF-8, точные escaped UTF-16 code units, bounded bytes.
 * Fastify parser отключён; превышение потока не уничтожает socket до отправки JSON 413.
 */
@Injectable()
export class JsonBodyPipe implements PipeTransform<
  FastifyRequest,
  Promise<Record<string, unknown>>
> {
  /**
   * Использует тот же исходный Web stream, что необязательный предшествующий handler.
   */
  constructor(
    /* Общий byte-preserving адаптер текущего native request. */
    @Inject(RequestAdapter) private readonly requests: RequestAdapter,
  ) {}

  /**
   * Читает body до вызова предметного сервиса. Отказ не открывает проектное соединение.
   */
  async transform(request: FastifyRequest): Promise<Record<string, unknown>> {
    const input = this.requests.get(request);
    if (
      request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    ) {
      await input.body?.cancel();
      throw new RelayError("UNSUPPORTED_MEDIA_TYPE", httpMessages.media, 2);
    }
    if (Number(request.headers["content-length"]) > HTTP_BODY_MAX_BYTES) {
      await input.body?.cancel();
      throw new RelayError("PAYLOAD_TOO_LARGE", httpMessages.large, 2);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = input.body?.getReader();
    if (reader === undefined) {
      throw new RelayError("INVALID_ARGUMENT", httpMessages.json, 2);
    }
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        length += chunk.value.byteLength;
        if (length > HTTP_BODY_MAX_BYTES) {
          await reader.cancel();
          throw new RelayError("PAYLOAD_TOO_LARGE", httpMessages.large, 2);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)),
      );
    } catch {
      throw new RelayError("INVALID_ARGUMENT", httpMessages.json, 2);
    }
    if (!isObject(value)) {
      throw new RelayError("INVALID_ARGUMENT", httpMessages.json, 2);
    }
    return value;
  }
}
