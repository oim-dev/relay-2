import "reflect-metadata";
import { Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { RelayServerOptions } from "./server.types";
import { SERVER_OPTIONS } from "./http/options";
import { ApiExceptionFilter } from "./http/errors";
import { JsonBodyPipe } from "./http/json-body.pipe";
import { RequestLifetime } from "./http/request-lifetime";
import { RequestAdapter } from "./http/request-adapter";
import { LocalPolicyGuard } from "./http/local-policy.guard";
import { LifetimeInterceptor } from "./http/lifetime.interceptor";
import { ProjectsService } from "./modules/projects/projects.service";
import { ProjectsController } from "./modules/projects/projects.controller";
import { QueriesController } from "./modules/queries/queries.controller";
import { CommandsController } from "./modules/commands/commands.controller";
import { KnowledgeController } from "./modules/knowledge/knowledge.controller";
import { TasksController } from "./modules/tasks/tasks.controller";
import { PlanningController } from "./modules/planning/planning.controller";
import { HistoryController } from "./modules/history/history.controller";
import { EventsService } from "./modules/events/events.service";
import { EventsController } from "./modules/events/events.controller";
import { GitSyncService } from "./modules/git-sync/git-sync.service";
import { GitSyncController } from "./modules/git-sync/git-sync.controller";
import { AssetsController } from "./modules/assets/assets.controller";

/**
 * Общие владельцы Runtime scope и HTTP lifetime, изолированные одним Nest application.
 */
@Global()
@Module({})
class RuntimeModule {
  /**
   * Публикует явную конфигурацию; ProjectsService разрешает область только при Nest init.
   */
  static register(options: RelayServerOptions): DynamicModule {
    return {
      module: RuntimeModule,
      providers: [
        { provide: SERVER_OPTIONS, useValue: options },
        ProjectsService,
        RequestLifetime,
        JsonBodyPipe,
        RequestAdapter,
      ],
      exports: [SERVER_OPTIONS, ProjectsService, RequestLifetime, JsonBodyPipe, RequestAdapter],
    };
  }
}

/**
 * Каталог контроллеров для reflection-проверки и read-only генерации, без создания Nest приложения.
 */
export const API_CONTROLLERS = [
  ProjectsController,
  QueriesController,
  CommandsController,
  KnowledgeController,
  TasksController,
  PlanningController,
  HistoryController,
  GitSyncController,
  EventsController,
  AssetsController,
] as const;

/**
 * Локальные предметные HTTP-сценарии над Core, без собственного хранения или бизнес-сервисов.
 */
@Module({
  controllers: [
    ProjectsController,
    QueriesController,
    CommandsController,
    KnowledgeController,
    TasksController,
    PlanningController,
    HistoryController,
  ],
})
class LocalApiModule {}

/**
 * Процессная оркестрация Git Sync отделена от локальных чтений и записей.
 */
@Module({ controllers: [GitSyncController], providers: [GitSyncService] })
class GitSyncModule {}

/**
 * Единственный владелец SSE timers и subscriptions.
 */
@Module({ controllers: [EventsController], providers: [EventsService], exports: [EventsService] })
class EventsModule {}

/**
 * Корневая композиция настоящих Nest modules/controllers/guards/pipes/filter.
 */
@Module({})
export class ServerModule {
  /**
   * Собирает приложение из явной конфигурации, не изменяя environment процесса.
   */
  static register(options: RelayServerOptions): DynamicModule {
    return {
      module: ServerModule,
      imports: [RuntimeModule.register(options), LocalApiModule, GitSyncModule, EventsModule],
      controllers: [AssetsController],
      providers: [
        { provide: APP_GUARD, useClass: LocalPolicyGuard },
        { provide: APP_INTERCEPTOR, useClass: LifetimeInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    };
  }
}
