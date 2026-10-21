import type {
  EntityRecord,
  KnowledgeRecord,
  ReleaseRecord,
  TaskRecord,
  WorkPlanRecord,
} from "@relay/contracts";
import type { KnowledgeService, PlanningService, TasksService } from "@relay/core";
import type { ProjectDatabase } from "@relay/storage";

/**
 * Сервисы одного изолированного проекта; соединением и каталогом владеет fixture.
 */
export interface WorkflowFixture {
  /* Файловая SQLite-база проекта, закрываемая после сценария. */
  readonly db: ProjectDatabase;
  /* Предметные операции над требованиями и реализациями этого проекта. */
  readonly knowledge: KnowledgeService;
  /* Предметные операции над задачами этого проекта. */
  readonly tasks: TasksService;
  /* Предметные операции над планами и релизами этого проекта. */
  readonly planning: PlanningService;
}

/**
 * Связный маршрут экспорта с внешней зависимостью, приёмкой, планом и будущим выпуском.
 * Записи содержат исходные ревизии: helper завершения не подменяет их свежими.
 */
export interface Workflow {
  /* Продуктовая возможность экспорта. */
  readonly feature: KnowledgeRecord<"feature">;
  /* Пользовательский сценарий этой возможности. */
  readonly scenario: KnowledgeRecord<"scenario">;
  /* Приложение, владеющее доской реализации. */
  readonly application: KnowledgeRecord<"application">;
  /* Участие приложения в реализации возможности. */
  readonly featureImplementation: KnowledgeRecord<"implementation">;
  /* Участие приложения в реализации сценария. */
  readonly scenarioImplementation: KnowledgeRecord<"implementation">;
  /* Внешняя зависимость, не включённая в явный состав плана. */
  readonly preparation: TaskRecord;
  /* Задача реализации с критерием и зависимостью от подготовки. */
  readonly implementation: TaskRecord;
  /* Продуктовая приёмка, зависящая от задачи реализации. */
  readonly acceptance: TaskRecord;
  /* План с задачами реализации и приёмки. */
  readonly plan: WorkPlanRecord;
  /* Локальный ID единственного этапа плана. */
  readonly stageId: string;
  /* Запланированный релиз, ссылающийся на план. */
  readonly release: ReleaseRecord;
}

/**
 * Снимок всех записей и поколения для проверки отката межпредметного пакета.
 */
export interface WorkflowSnapshot {
  /* Записи в порядке Storage, включая содержание и исходные ревизии. */
  readonly entities: readonly EntityRecord[];
  /* Поколение проекта на момент снимка. */
  readonly generation: number;
}
