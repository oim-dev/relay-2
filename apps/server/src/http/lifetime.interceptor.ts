import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { from, lastValueFrom, type Observable } from "rxjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RelayServerOptions } from "../server.types";
import { SERVER_OPTIONS } from "./options";
import { RequestLifetime } from "./request-lifetime";
import { sendResponse } from "./response";
import { RequestAdapter } from "./request-adapter";

/**
 * Удерживает Nest handler и его pipes до результата, не связывая Core commit с HTTP disconnect.
 */
@Injectable()
export class LifetimeInterceptor implements NestInterceptor {
  /**
   * Получает per-application lifecycle и необязательный integration handler.
   */
  constructor(
    /* Учёт принятых handlers независимо от сетевого disconnect. */
    @Inject(RequestLifetime) private readonly lifetime: RequestLifetime,
    /* Необязательный integration handler вызывающего приложения. */
    @Inject(SERVER_OPTIONS) private readonly options: RelayServerOptions,
    /* Единственный Fetch reader одного native request. */
    @Inject(RequestAdapter) private readonly requests: RequestAdapter,
  ) {}

  /**
   * Учитывает полное выполнение handler, включая static/control ответы и первоначальный SSE read.
   */
  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    return from(
      this.lifetime.run(async () => {
        if (this.options.controlHandler !== undefined) {
          const request = context.switchToHttp().getRequest<FastifyRequest>();
          const reply = context.switchToHttp().getResponse<FastifyReply>();
          const response = await this.options.controlHandler(this.requests.get(request, reply));
          if (response !== null) {
            await sendResponse(
              response,
              request,
              context.switchToHttp().getResponse<FastifyReply>(),
            );
            return undefined;
          }
        }
        return await lastValueFrom(next.handle());
      }),
    );
  }
}
