import { Controller, Inject, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { HistoryService } from "@relay/core";
import type { HttpApiSchemas } from "@relay/contracts";
import { Operation } from "../../http/operation";
import { booleanQuery, filters, QueryInput, single } from "../../http/query";
import { ProjectsService } from "../projects/projects.service";

/**
 * История текущего Core: сессии, контекст, дерево и неизменяемые материалы.
 * List/tree/context сохраняют стоимость полного предметного состава и обычные массивы DTO.
 */
@ApiTags("История")
@Controller()
export class HistoryController {
  /**
   * Получает владельца проектных соединений и согласованных snapshots.
   */
  constructor(
    /* Проверенная область и владелец snapshots истории. */
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  /**
   * Читает отфильтрованные сессии; root=true передаётся Core как parent:null.
   */
  @Operation("historySessions")
  async sessions(
    @Param("projectId") projectId: string,
    @QueryInput() query: URLSearchParams,
  ): Promise<HttpApiSchemas["historySessions"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new HistoryService(db).list(filters(query, [], true))),
    }));
  }

  /**
   * Читает карточку одной сессии по постоянному ID либо пользовательской ссылке.
   */
  @Operation("historySession")
  async session(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["historySession"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new HistoryService(db).get(ref)),
    }));
  }

  /**
   * Читает составной контекст сессии в одном snapshot.
   */
  @Operation("historyContext")
  async context(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["historyContext"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new HistoryService(db).context(ref)),
    }));
  }

  /**
   * Возвращает дерево сессий в порядке обхода Core, без транспортной переупаковки массива.
   */
  @Operation("historyTree")
  async tree(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["historyTree"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new HistoryService(db).tree(ref)),
    }));
  }

  /**
   * Читает открытые намерения с явно заданной глубиной дочерних сессий.
   */
  @Operation("historyIntents")
  async intents(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
    @QueryInput() query: URLSearchParams,
  ): Promise<HttpApiSchemas["historyIntents"]> {
    const children = booleanQuery(query, "includeChildren") ?? false;
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new HistoryService(db).intents(ref, children)),
    }));
  }

  /**
   * Читает журнал материалов всего проекта либо одной сессии.
   */
  @Operation("historyCheckpoints")
  async checkpoints(
    @Param("projectId") projectId: string,
    @QueryInput() query: URLSearchParams,
  ): Promise<HttpApiSchemas["historyCheckpoints"]> {
    const session = single(query, "session") ?? undefined;
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new HistoryService(db).history(session)),
    }));
  }

  /**
   * Возвращает один материал без изменения checkpoint union и необязательных полей.
   */
  @Operation("historyCheckpoint")
  async checkpoint(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["historyCheckpoint"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new HistoryService(db).getCheckpoint(ref)),
    }));
  }
}
