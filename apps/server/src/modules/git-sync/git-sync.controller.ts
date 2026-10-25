import { Controller, Inject, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { HttpApiSchemas } from "@relay/contracts";
import { Operation } from "../../http/operation";
import { RawBody, JsonBodyPipe } from "../../http/json-body.pipe";
import { invalidInput } from "../../http/query";
import { GitSyncService } from "./git-sync.service";

/**
 * Явные HTTP действия процессного порта Git Sync, изолированного от Nest/Core DI.
 */
@ApiTags("Git Sync")
@Controller()
export class GitSyncController {
  /**
   * Получает единственного владельца Runtime request orchestration.
   */
  constructor(
    /* Единственный HTTP владелец процессной оркестрации Git Sync. */
    @Inject(GitSyncService) private readonly git: GitSyncService,
  ) {}

  /**
   * Возвращает cached status без Git fetch.
   */
  @Operation("gitSyncStatus")
  async status(@Param("projectId") projectId: string): Promise<HttpApiSchemas["gitSyncStatus"]> {
    return { ok: true, data: await this.git.status(projectId) };
  }

  /**
   * Принимает только пустой объект и запускает ровно один bounded now.
   */
  @Operation("gitSyncNow")
  async now(
    @Param("projectId") projectId: string,
    @RawBody(JsonBodyPipe) body: Record<string, unknown>,
  ): Promise<HttpApiSchemas["gitSyncNow"]> {
    if (Object.keys(body).length !== 0) {
      invalidInput("body");
    }
    return { ok: true, data: await this.git.now(projectId) };
  }

  /**
   * Возвращает прежний outcome; unknown не объявляется подтверждённым успехом now.
   */
  @Operation("gitSyncRequest")
  async request(
    @Param("projectId") projectId: string,
    @Param("requestId") requestId: string,
  ): Promise<HttpApiSchemas["gitSyncRequest"]> {
    return { ok: true, data: await this.git.outcome(projectId, requestId) };
  }

  /**
   * Возвращает conflicts и pending dependencies в их исходной типизированной форме.
   */
  @Operation("gitSyncConflicts")
  async conflicts(
    @Param("projectId") projectId: string,
  ): Promise<HttpApiSchemas["gitSyncConflicts"]> {
    return { ok: true, data: await this.git.conflicts(projectId) };
  }

  /**
   * Возвращает одну conflict/pending проекцию.
   */
  @Operation("gitSyncConflict")
  async conflict(
    @Param("projectId") projectId: string,
    @Param("id") id: string,
  ): Promise<HttpApiSchemas["gitSyncConflict"]> {
    return { ok: true, data: await this.git.conflict(projectId, id) };
  }
}
