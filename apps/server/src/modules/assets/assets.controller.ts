import { All, Controller, Get, Inject, Req, Res } from "@nestjs/common";
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from "@nestjs/swagger";
import { RelayError } from "@relay/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import openapi from "../../../openapi.json";
import type { RelayServerOptions } from "../../server.types";
import { SERVER_OPTIONS } from "../../http/options";
import { httpMessages } from "../../http/http.messages";
import { fetchHead, sendResponse } from "../../http/response";
import { canonicalAssetPath } from "./static-handler";

/**
 * Публичная спецификация, preflight и static fallback внутри настоящего Nest routing.
 */
@ApiTags("Server")
@Controller()
export class AssetsController {
  /**
   * Получает явно переданный static provider; отсутствие оставляет только API.
   */
  constructor(
    /* Явно переданный staticHandler готовых Web-ресурсов. */
    @Inject(SERVER_OPTIONS) private readonly options: RelayServerOptions,
  ) {}

  /**
   * Возвращает сгенерированный контракт текущих Nest endpoints.
   */
  @Get("/openapi.json")
  @ApiOperation({ operationId: "openapi" })
  document(): typeof openapi {
    return openapi;
  }

  /**
   * Обслуживает preflight/статику после общего guard; неизвестные API остаются JSON 404.
   */
  @All("*")
  @ApiExcludeEndpoint()
  async fallback(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    if (request.method === "OPTIONS") {
      reply
        .header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type, Accept")
        .code(204)
        .send();
      return;
    }
    const path = canonicalAssetPath(request.url.split("?", 1)[0] ?? "");
    if (
      path !== null &&
      path !== "/api" &&
      !path.startsWith("/api/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      const response = await this.options.staticHandler?.(fetchHead(request));
      if (response !== null && response !== undefined) {
        await sendResponse(response, request, reply);
        return;
      }
    }
    throw new RelayError("NOT_FOUND", httpMessages.missing, 3);
  }
}
