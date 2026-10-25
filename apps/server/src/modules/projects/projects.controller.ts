import { Controller, Inject, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { QueryService } from "@relay/core";
import type { HttpApiSchemas } from "@relay/contracts";
import { Operation } from "../../http/operation";
import { ProjectsService } from "./projects.service";

/**
 * Контекст сервера и общепроектные чтения текущего Core.
 */
@ApiTags("Проекты")
@Controller()
export class ProjectsController {
  /**
   * Получает владельца Runtime/SQLite области одного сервера.
   */
  constructor(
    /* Проверенный каталог Runtime и владелец проектных соединений. */
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  /**
   * Возвращает зафиксированный каталог регистраций, включая недоступные элементы workspace.
   */
  @Operation("context")
  context(): HttpApiSchemas["context"] {
    return { ok: true, data: this.projects.context };
  }

  /**
   * Читает компактный обзор одного Core snapshot без выдачи полного списка сущностей.
   */
  @Operation("overview")
  async overview(@Param("projectId") projectId: string): Promise<HttpApiSchemas["overview"]> {
    return this.projects.run(projectId, (db) => {
      const { project, generation, counts, tasks } = new QueryService(db).overview();
      return { ok: true, data: { project, generation, counts, tasks } };
    });
  }

  /**
   * Читает технические счётчики Core без загрузки содержания.
   */
  @Operation("projectStatus")
  async status(@Param("projectId") projectId: string): Promise<HttpApiSchemas["projectStatus"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: new QueryService(db).status(),
    }));
  }

  /**
   * Выполняет явную полную диагностику целостности Core.
   */
  @Operation("projectCheck")
  async check(@Param("projectId") projectId: string): Promise<HttpApiSchemas["projectCheck"]> {
    return this.projects.run(projectId, (db) => ({ ok: true, data: new QueryService(db).check() }));
  }
}
