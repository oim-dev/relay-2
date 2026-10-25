import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { responseSignal, sendResponse } from "../../http/response";
import { EventsService } from "./events.service";

/**
 * Реальный Nest endpoint SSE; Web→Node bridge сохраняет backpressure и disconnect cleanup.
 */
@ApiTags("События")
@Controller()
export class EventsController {
  /**
   * Получает единственного per-application владельца watchers.
   */
  constructor(
    /* Общий watcher проекта для всех SSE subscriptions. */
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /**
   * Подключает инвалидирующие события проекта; reconnect начинается с нового connected.
   */
  @Get("/api/v2/projects/:projectId/events")
  @ApiOperation({ operationId: "events" })
  @ApiProduces("text/event-stream")
  async eventsStream(
    @Param("projectId") projectId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const response = await this.events.response(projectId, responseSignal(request, reply));
    await sendResponse(response, request, reply);
  }
}
