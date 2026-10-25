import { Controller, Inject, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PlanningService, TasksService } from "@relay/core";
import type { HttpApiSchemas } from "@relay/contracts";
import { Operation } from "../../http/operation";
import { ProjectsService } from "../projects/projects.service";

/**
 * Предметные проекции задач, критериев и независимого журнала; каждый состав читается snapshot.
 */
@ApiTags("Задачи")
@Controller()
export class TasksController {
  /**
   * Получает владельца Runtime/SQLite области.
   */
  constructor(
    /* Проверенная область и владелец snapshots задач. */
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  /**
   * Вычисляет текущую готовность по графу обязательств Core.
   */
  @Operation("taskProgress")
  async progress(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["taskProgress"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new TasksService(db).progress(ref)),
    }));
  }

  /**
   * Читает независимый журнал задачи вместе с исходной ревизией владельца.
   */
  @Operation("taskComments")
  async comments(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["taskComments"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new TasksService(db).commentsWithOwner(ref)),
    }));
  }

  /**
   * Читает один комментарий строго внутри указанной задачи.
   */
  @Operation("taskComment")
  async comment(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
    @Param("id") id: string,
  ): Promise<HttpApiSchemas["taskComment"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new TasksService(db).getComment(ref, id)),
    }));
  }

  /**
   * Читает критерии с ревизией содержания задачи-владельца.
   */
  @Operation("taskCriteria")
  async criteria(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["taskCriteria"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new TasksService(db).criteriaWithOwner(ref)),
    }));
  }

  /**
   * Читает критерий по постоянному ID внутри адресованной задачи.
   */
  @Operation("taskCriterion")
  async criterion(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
    @Param("id") id: string,
  ): Promise<HttpApiSchemas["taskCriterion"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new TasksService(db).getCriterion(ref, id)),
    }));
  }

  /**
   * Читает прямые зависимости и ревизию владельца одним снимком.
   */
  @Operation("taskDependencies")
  async dependencies(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["taskDependencies"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new TasksService(db).dependenciesWithOwner(ref)),
    }));
  }

  /**
   * Возвращает обычный массив прямых дочерних задач без фиктивной оболочки items.
   */
  @Operation("taskChildren")
  async children(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["taskChildren"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new TasksService(db).children(ref)),
    }));
  }

  /**
   * Читает необязательные связи в сохранённом порядке из того же snapshot, что владелец.
   */
  @Operation("taskRelated")
  async related(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["taskRelated"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => {
        const tasks = new TasksService(db);
        return tasks.get(ref).data.related.map((id) => tasks.get(id));
      }),
    }));
  }

  /**
   * Возвращает текущие и исторические включения задачи в планы через владельца Planning.
   */
  @Operation("taskMemberships")
  async memberships(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["taskMemberships"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new PlanningService(db).memberships(ref)),
    }));
  }
}
