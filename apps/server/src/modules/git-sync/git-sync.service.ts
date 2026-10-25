import { Inject, Injectable } from "@nestjs/common";
import { RelayError, type HttpReadResults } from "@relay/contracts";
import type { RelayServerOptions } from "../../server.types";
import { SERVER_OPTIONS } from "../../http/options";
import { httpMessages } from "../../http/http.messages";
import { isObject } from "../../http/json-body.pipe";
import { ProjectsService } from "../projects/projects.service";
import { cachedStatus, decodeResult } from "./response-decoder";

/**
 * Единственная HTTP→Runtime процессная граница Git Sync; сеть и Git принадлежат отдельному приложению.
 */
@Injectable()
export class GitSyncService {
  /**
   * Получает явный процессный клиент и проверенный каталог серверных проектов.
   */
  constructor(
    /* Явный GitSyncClient caller; отсутствие означает GIT_SYNC_UNAVAILABLE. */
    @Inject(SERVER_OPTIONS) private readonly options: RelayServerOptions,
    /* Проверяет физический проект до каждого process request. */
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  /**
   * Выполняет один процессный запрос после проверки физического проекта; без hidden retry.
   */
  private async request(
    projectId: string,
    action: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const client = this.options.gitSync;
    if (client === undefined) {
      throw new RelayError("GIT_SYNC_UNAVAILABLE", httpMessages.gitUnavailable);
    }
    return this.projects.run(projectId, () =>
      client.request({
        version: 1,
        action,
        input,
        options: this.projects.target(projectId).options,
      }),
    );
  }

  /**
   * Читает только cached status, явно запрещая refresh/network polling.
   */
  async status(projectId: string): Promise<HttpReadResults["gitSyncStatus"]> {
    return cachedStatus(await this.request(projectId, "status", { refresh: false }));
  }

  /**
   * Читает сохранённый outcome, проверяя исходный requestId без нового now.
   */
  async outcome(projectId: string, requestId: string): Promise<HttpReadResults["gitSyncRequest"]> {
    const result = await this.request(projectId, "request.get", { requestId });
    if (!isObject(result) || result.requestId !== requestId) {
      throw new RelayError("GIT_SYNC_INVALID_RESPONSE", httpMessages.gitResponse);
    }
    return decodeResult("gitSyncRequest", result);
  }

  /**
   * Назначает operationId до submit. Настоящий now возвращает summary+requestId;
   * полный outcome читается отдельным request.get. Timeout сохраняет исходную Runtime ошибку.
   */
  async now(projectId: string): Promise<HttpReadResults["gitSyncRequest"]> {
    const requestId = crypto.randomUUID();
    const summary = await this.request(projectId, "now", { operationId: requestId });
    if (!isObject(summary) || summary.requestId !== requestId) {
      throw new RelayError("GIT_SYNC_INVALID_RESPONSE", httpMessages.gitResponse);
    }
    return this.outcome(projectId, requestId);
  }

  /**
   * Читает полную диагностику conflicts/pending через владельца Runtime.
   */
  async conflicts(projectId: string): Promise<HttpReadResults["gitSyncConflicts"]> {
    return decodeResult("gitSyncConflicts", await this.request(projectId, "conflicts.list", {}));
  }

  /**
   * Читает стороны конкретного changeset без потери conflict/pending discriminator.
   */
  async conflict(projectId: string, id: string): Promise<HttpReadResults["gitSyncConflict"]> {
    return decodeResult("gitSyncConflict", await this.request(projectId, "conflicts.get", { id }));
  }
}
