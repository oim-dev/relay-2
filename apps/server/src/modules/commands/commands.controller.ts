import { Controller, Inject, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { BatchService } from "@relay/core";
import type { HttpApiSchemas } from "@relay/contracts";
import { Operation } from "../../http/operation";
import { JsonBodyPipe, RawBody } from "../../http/json-body.pipe";
import { invalidInput, QueryInput, single } from "../../http/query";
import { ProjectsService } from "../projects/projects.service";
import { writeContext } from "./write-input";

/**
 * Одиночные и пакетные команды проходят один Core executor с атомарной первоначальной receipt.
 */
@ApiTags("Команды и квитанции")
@Controller()
export class CommandsController {
  /**
   * Получает владельца соединений, удерживаемых до окончания Promise commit.
   */
  constructor(
    /* Удерживает соединение до исхода Core writer. */
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  /**
   * Исполняет ровно одну NamedCommand без подмены ifRevision, tokens и адресных guards.
   */
  @Operation("command")
  async command(
    @Param("projectId") projectId: string,
    @RawBody(JsonBodyPipe) body: Record<string, unknown>,
  ): Promise<HttpApiSchemas["command"]> {
    const options = writeContext(body, false);
    const { actor: _actor, operationKey: _key, expectedAddresses: _addresses, ...command } = body;
    return this.projects.run(projectId, async (db) => ({
      ok: true,
      data: await new BatchService(db).execute({ version: 1, operations: [command] }, options),
    }));
  }

  /**
   * Исполняет атомарный пакет; check откатывает изменения и не сохраняет квитанцию.
   */
  @Operation("batch")
  async batch(
    @Param("projectId") projectId: string,
    @RawBody(JsonBodyPipe) body: Record<string, unknown>,
  ): Promise<HttpApiSchemas["batch"]> {
    const options = writeContext(body, true);
    if (
      Object.keys(body).some(
        (key) => !["commands", "actor", "operationKey", "expectedAddresses", "check"].includes(key),
      )
    ) {
      invalidInput("body");
    }
    return this.projects.run(projectId, async (db) => ({
      ok: true,
      data: await new BatchService(db).execute({ version: 1, operations: body.commands }, options),
    }));
  }

  /**
   * Читает первоначальный исход по обязательному query-ключу, включая буквальные . и ...
   */
  @Operation("receipt")
  async receipt(
    @Param("projectId") projectId: string,
    @QueryInput() query: URLSearchParams,
  ): Promise<HttpApiSchemas["receipt"]> {
    const key = single(query, "operationKey");
    if (key === null) {
      invalidInput("operationKey");
    }
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: new BatchService(db).getResult(key),
    }));
  }
}
