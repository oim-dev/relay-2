import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { RelayError } from "@relay/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RelayServerOptions } from "../server.types";
import { SERVER_OPTIONS } from "./options";
import { RequestLifetime } from "./request-lifetime";
import { httpMessages } from "./http.messages";

/**
 * Принимает только канонический loopback authority, разрешая эквивалентные :80 и отсутствие порта.
 * Userinfo, path/query/fragment, пробелы, альтернативные IPv4 и неоднозначные записи порта запрещены.
 */
function canonicalLocalHost(value: string | undefined): string | null {
  if (
    value === undefined ||
    !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::(?:0|[1-9]\d{0,4}))?$/.test(value)
  ) {
    return null;
  }
  try {
    const authority = new URL(`http://${value}`);
    return authority.host;
  } catch {
    return null;
  }
}

/**
 * Проверяет полный HTTP(S) origin без добавления slash или исправления произвольного URL.
 * Единственная принимаемая неканоническая форма — явный стандартный порт протокола.
 */
function canonicalOrigin(value: string): string | null {
  try {
    const origin = new URL(value);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      return null;
    }
    const defaultPort = origin.protocol === "http:" ? "80" : "443";
    if (value !== origin.origin && value !== `${origin.origin}:${defaultPort}`) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

/**
 * Защищает loopback REST и статику от DNS rebinding и cross-origin браузерных запросов.
 * Отдельные dev origins разрешает только явная конфигурация caller.
 */
@Injectable()
export class LocalPolicyGuard implements CanActivate {
  /**
   * Получает изолированную конфигурацию и барьер graceful shutdown через явные DI tokens.
   */
  constructor(
    /* Явно разрешённые hosts/origins текущего приложения. */
    @Inject(SERVER_OPTIONS) private readonly options: RelayServerOptions,
    /* Барьер приёма HTTP-сценариев при graceful shutdown. */
    @Inject(RequestLifetime) private readonly lifetime: RequestLifetime,
  ) {}

  /**
   * Проверяет Host/Origin до чтения body и открытия предметного соединения.
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    reply.header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store");
    const host = canonicalLocalHost(request.headers.host);
    if (
      host === null ||
      (this.options.allowedHosts !== undefined &&
        !this.options.allowedHosts.some((allowed) => canonicalLocalHost(allowed) === host))
    ) {
      throw new RelayError("HOST_FORBIDDEN", httpMessages.host, 2);
    }
    const origin = request.headers.origin;
    const normalizedOrigin = origin === undefined ? null : canonicalOrigin(origin);
    if (
      (origin !== undefined &&
        (normalizedOrigin === null ||
          (normalizedOrigin !== `http://${host}` &&
            !this.options.allowedOrigins?.includes(origin)))) ||
      (origin === undefined && request.headers["sec-fetch-site"] === "cross-site")
    ) {
      throw new RelayError("ORIGIN_FORBIDDEN", httpMessages.origin, 2);
    }
    if (origin !== undefined) {
      reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
    }
    this.lifetime.assertOpen();
    return true;
  }
}
