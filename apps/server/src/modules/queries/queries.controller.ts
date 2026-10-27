import { Controller, Inject, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { RelayError, type HttpApiSchemas } from "@relay/contracts";
import { QueryService, readRelationNeighborhood } from "@relay/core";
import { Operation } from "../../http/operation";
import { booleanQuery, filters, invalidInput, QueryInput, single } from "../../http/query";
import { httpMessages } from "../../http/http.messages";
import { ProjectsService } from "../projects/projects.service";
import { readPage } from "./page";
import { relationNeighborhoodQuery } from "./graph-view-query";

/**
 * Адресные чтения, согласованные страницы и поиск с точной full/summary union формой Core.
 */
@ApiTags("Чтения и поиск")
@Controller()
export class QueriesController {
  /**
   * Читает bounded соседство существующих структурированных полей одним Core snapshot.
   */
  @Operation("relationNeighborhood")
  async relations(
    @Param("projectId") projectId: string,
    @QueryInput() query: URLSearchParams,
  ): Promise<HttpApiSchemas["relationNeighborhood"]> {
    const input = relationNeighborhoodQuery(query);
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: readRelationNeighborhood(db, input),
    }));
  }
  /**
   * Получает зарегистрированную область Runtime и владельца соединений.
   */
  constructor(
    /* Проверенный Runtime anchor и соединения для согласованных чтений. */
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  /**
   * Читает карточку по одиночному query ref, сохраняя dot-адреса без нормализации URL пути.
   * Versioned режим читает данные и переносимые tokens одного anchor.
   */
  @Operation("entity")
  async entity(
    @Param("projectId") projectId: string,
    @QueryInput() query: URLSearchParams,
  ): Promise<HttpApiSchemas["entity"]> {
    const ref = single(query, "ref");
    if (ref === null) {
      invalidInput("ref");
    }
    const versioned = booleanQuery(query, "withVersions") ?? false;
    return this.projects.run(projectId, async (db) => {
      const service = new QueryService(db);
      if (!versioned) {
        return { ok: true, data: service.get(ref) };
      }
      const read = await service.getManyVersioned([ref]);
      if (read.data.view !== "full") {
        throw new RelayError("INTERNAL_ERROR", httpMessages.internal);
      }
      const item = read.data.items[0];
      if (item === undefined) {
        throw new RelayError("INTERNAL_ERROR", httpMessages.internal);
      }
      if (!item.ok) {
        throw new RelayError(
          item.error.code,
          item.error.message,
          item.error.exitCode,
          item.error.details,
        );
      }
      return {
        ok: true,
        data: item.entity,
        meta: { versions: read.versions, generation: read.data.generation },
      };
    });
  }

  /**
   * Отдаёт items/total/generation из единого snapshot с проверкой продолжения.
   */
  @Operation("entities")
  async entities(
    @Param("projectId") projectId: string,
    @QueryInput() query: URLSearchParams,
  ): Promise<HttpApiSchemas["entities"]> {
    return this.projects.run(projectId, (db) => ({ ok: true, data: readPage(db, query) }));
  }

  /**
   * Читает адресный набор без потери per-item ошибок, порядка и выбранного представления.
   */
  @Operation("getMany")
  async getMany(
    @Param("projectId") projectId: string,
    @QueryInput() query: URLSearchParams,
  ): Promise<HttpApiSchemas["getMany"]> {
    const summary = booleanQuery(query, "summary") ?? false;
    const versioned = booleanQuery(query, "withVersions") ?? false;
    return this.projects.run(projectId, async (db) => {
      const service = new QueryService(db);
      if (versioned) {
        const result = await service.getManyVersioned(query.getAll("ref"), { summary });
        return { ok: true, data: result.data, meta: { versions: result.versions } };
      }
      return { ok: true, data: service.getMany(query.getAll("ref"), { summary }) };
    });
  }

  /**
   * Поиск сохраняет текущие правила и стоимость Core, включая попытку точной адресации.
   */
  @Operation("search")
  async search(
    @Param("projectId") projectId: string,
    @QueryInput() query: URLSearchParams,
  ): Promise<HttpApiSchemas["search"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new QueryService(db).search(filters(query))),
    }));
  }
}
