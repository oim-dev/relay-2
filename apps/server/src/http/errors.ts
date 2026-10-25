import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { RelayError, type HttpError } from "@relay/contracts";
import type { FastifyReply } from "fastify";
import { httpMessages } from "./http.messages";

/**
 * Сохраняет Relay диагностику без раскрытия внутренних stack/path неожиданных ошибок.
 */
export function publicError(error: unknown): HttpError {
  if (error instanceof RelayError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof HttpException) {
    switch (error.getStatus()) {
      case 400:
        return { code: "INVALID_ARGUMENT", message: httpMessages.input };
      case 404:
        return { code: "NOT_FOUND", message: httpMessages.missing };
      case 413:
        return { code: "PAYLOAD_TOO_LARGE", message: httpMessages.large };
      case 415:
        return { code: "UNSUPPORTED_MEDIA_TYPE", message: httpMessages.media };
    }
  }
  return { code: "INTERNAL_ERROR", message: httpMessages.internal };
}

/**
 * Отображает стабильный предметный код и exitCode в HTTP, не распознавая тексты.
 */
export function httpStatus(error: unknown): number {
  if (!(error instanceof RelayError)) {
    return error instanceof HttpException ? error.getStatus() : 500;
  }
  if (["HOST_FORBIDDEN", "ORIGIN_FORBIDDEN"].includes(error.code)) {
    return 403;
  }
  if (["SERVER_CLOSING", "GIT_SYNC_UNAVAILABLE"].includes(error.code)) {
    return 503;
  }
  if (error.code === "PAYLOAD_TOO_LARGE") {
    return 413;
  }
  if (error.code === "UNSUPPORTED_MEDIA_TYPE") {
    return 415;
  }
  if (error.exitCode === 3 || error.code === "NOT_FOUND") {
    return 404;
  }
  if (error.exitCode === 4) {
    return 409;
  }
  return error.exitCode === 2 ? 400 : 500;
}

/**
 * Единый Nest exception filter для REST, pipes, guards и stream bootstrap до headers.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  /**
   * Отправляет JSON envelope; начатый stream уже не заменяется JSON-документом.
   */
  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (!reply.sent && !reply.raw.destroyed) {
      reply.code(httpStatus(error)).send({ ok: false, error: publicError(error) });
    }
  }
}
