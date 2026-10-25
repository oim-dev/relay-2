import { Controller, Inject, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { KnowledgeService } from "@relay/core";
import type { HttpApiSchemas } from "@relay/contracts";
import { Operation } from "../../http/operation";
import { ProjectsService } from "../projects/projects.service";

/**
 * Проекции знаний: разделами владеет проект, связями документ, участием приложение.
 */
@ApiTags("Знания и документы")
@Controller()
export class KnowledgeController {
  /**
   * Получает владельца изолированных проектных соединений.
   */
  constructor(
    /* Проверенная область и владелец snapshots знаний. */
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  /**
   * Читает разделы с исходной ревизией проекта-владельца в одном snapshot.
   */
  @Operation("documentSections")
  async sections(
    @Param("projectId") projectId: string,
  ): Promise<HttpApiSchemas["documentSections"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new KnowledgeService(db).documentSections()),
    }));
  }

  /**
   * Читает связи документа и ревизию их владельца согласованно.
   */
  @Operation("documentLinks")
  async links(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["documentLinks"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new KnowledgeService(db).documentLinks(ref)),
    }));
  }

  /**
   * Читает активные реализации приложения по текущим правилам Core.
   */
  @Operation("applicationParticipation")
  async participation(
    @Param("projectId") projectId: string,
    @Param("ref") ref: string,
  ): Promise<HttpApiSchemas["applicationParticipation"]> {
    return this.projects.run(projectId, (db) => ({
      ok: true,
      data: db.snapshot(() => new KnowledgeService(db).participation(ref)),
    }));
  }
}
