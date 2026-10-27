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
export { TaskViewsService } from "./tasks/task-views";
export { BatchService, CommandExecutor, executeCommands } from "./batch/batch";
export { readVersionedEntity } from "./commands/command-versioned-read";
export { BATCH_OPERATIONS } from "./batch/batch-catalog";
export type { TaskReadOwner, TaskCollection, TaskCriterionRead } from "./tasks/task-read.types";
export { ReplicationService } from "./replication/replication";
export { REPLICATION_PUBLICATION_BUDGET } from "./replication/replication-selection";
export type {
  BoundedPreparedReplication,
  ReplicationPrepareOptions,
  ReplicationPublicationBudget,
  ReplicationPublicationSelection,
  ReplicationDependencyWait,
} from "./replication/replication-selection.types";
export {
  decodeReplicationSnapshot,
  validateReplicationHistory,
} from "./replication/replication-format";
export type { ValidatedReplicationHistory } from "./replication/replication-history-proof";
export { readHistoryTimeline } from "./history/history-timeline";
export { readRelationNeighborhood } from "./queries/relation-neighborhood";
