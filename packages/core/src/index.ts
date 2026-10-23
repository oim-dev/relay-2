/**
 * Локальная точка сборки публичных предметных сценариев для приложений Relay.
 * Универсальная мутация сущностей остаётся внутренним механизмом Core.
 */
export { ProjectDatabase } from "@relay/storage";
export { HistoryService } from "./history/history";
export { KnowledgeService } from "./knowledge/knowledge";
export type { ApplicationParticipation } from "./knowledge/knowledge.types";
export { PlanningService } from "./planning/planning";
export { QueryService } from "./queries/queries";
export { TasksService } from "./tasks/tasks";
export type { TaskReadOwner, TaskCollection, TaskCriterionRead } from "./tasks/task-read.types";
