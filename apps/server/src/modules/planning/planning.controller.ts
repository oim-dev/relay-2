import { Controller, Inject, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PlanningService } from "@relay/core";
import type { HttpApiSchemas } from "@relay/contracts";
import { Operation } from "../../http/operation";
import { ProjectsService } from "../projects/projects.service";

/**
 * Согласованные проекции планов, этапов и релизов текущего Core.
 */
@ApiTags("Планирование")
@Controller()
export class PlanningController {
  /**
   * Получает владельца проектных snapshots.
   */
  constructor(
    /* Проверенная область и владелец snapshots планирования. */
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  /**
   * Рассчитывает готовность плана по текущим предметным обязательствам.
   */
  @Operation("planProgress")
  async progress(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["planProgress"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new PlanningService(db).progress("work-plan", ref)),
    }));
  }

  /**
   * Читает этапы плана в сохранённом порядке с исходной ревизией владельца.
   */
  @Operation("planStages")
  async stages(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["planStages"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new PlanningService(db).listStages(ref)),
    }));
  }

  /**
   * Читает этап строго внутри указанного плана.
   */
  @Operation("planStage")
  async stage(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
    @Param("stageId") stageId: string,
  ): Promise<HttpApiSchemas["planStage"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new PlanningService(db).getStage(ref, stageId)),
    }));
  }

  /**
   * Читает состав этапа и связанные задачи в общем snapshot.
   */
  @Operation("planStageTasks")
  async stageTasks(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
    @Param("stageId") stageId: string,
  ): Promise<HttpApiSchemas["planStageTasks"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new PlanningService(db).stageTasks(ref, stageId)),
    }));
  }

  /**
   * Рассчитывает готовность релиза по текущим планам и задачам.
   */
  @Operation("releaseProgress")
  async releaseProgress(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["releaseProgress"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new PlanningService(db).progress("release", ref)),
    }));
  }

  /**
   * Читает состав релиза в сохранённом порядке вместе с ревизией владельца.
   */
  @Operation("releasePlans")
  async releasePlans(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["releasePlans"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new PlanningService(db).releasePlans(ref)),
    }));
  }
}
