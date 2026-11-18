import {
  componentCollectionNames,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_TARGET_KINDS,
  PLAN_SCOPE_KINDS,
  historyOperatorSources,
  historyRunStates,
  type ComponentKind,
} from "@relay/contracts";
import type { ColumnDefinition } from "./columns.types";

/**
 * Каждая независимо версионируемая предметная часть имеет свою физическую таблицу.
 * owner_id у таблицы известного вида ссылается непосредственно на её предметного владельца.
 */
export const COMPONENT_DEFINITIONS = {
  collection: {
    table: "component_collections",
    owner: "object_ids",
    columns: [
      { field: "field", column: "field", storage: "string", values: componentCollectionNames },
    ],
  },
  "task-criterion": {
    table: "task_criteria",
    owner: "tasks",
    columns: [
      { field: "title", column: "title", storage: "text" },
      { field: "summary", column: "summary", storage: "text" },
      { field: "description", column: "description", storage: "text" },
      { field: "completed", column: "completed", storage: "boolean" },
      { field: "completedAt", column: "completed_at", storage: "string", nullable: true },
      { field: "completedBy", column: "completed_by", storage: "string", nullable: true },
    ],
  },
  "task-dependency": {
    table: "task_dependencies",
    owner: "tasks",
    columns: [{ field: "taskId", column: "depends_on_task_id", storage: "string" }],
  },
  "task-related": {
    table: "task_relations",
    owner: "tasks",
    columns: [{ field: "taskId", column: "related_task_id", storage: "string" }],
  },
  "task-target": { table: "task_targets", owner: "tasks", columns: [] },
  "plan-stage": {
    table: "plan_stages",
    owner: "work_plans",
    columns: [
      { field: "title", column: "title", storage: "text" },
      { field: "summary", column: "summary", storage: "text" },
      { field: "outcome", column: "outcome", storage: "text" },
      { field: "completionConditions", column: "completion_conditions", storage: "text" },
    ],
  },
  "plan-task": {
    table: "plan_tasks",
    owner: "work_plans",
    columns: [
      { field: "stageId", column: "stage_id", storage: "string" },
      { field: "taskId", column: "task_id", storage: "string" },
    ],
  },
  "plan-scope": {
    table: "plan_scopes",
    owner: "work_plans",
    columns: [
      { field: "id", column: "target_id", storage: "string" },
      { field: "kind", column: "target_kind", storage: "string", values: PLAN_SCOPE_KINDS },
    ],
  },
  "plan-participant": {
    table: "plan_participants",
    owner: "work_plans",
    columns: [{ field: "participant", column: "participant", storage: "text" }],
  },
  "release-plan": {
    table: "release_plans",
    owner: "releases",
    columns: [{ field: "planId", column: "plan_id", storage: "string" }],
  },
  "document-relation": {
    table: "document_relations",
    owner: "documents",
    columns: [
      { field: "target.id", column: "target_id", storage: "string" },
      {
        field: "target.kind",
        column: "target_kind",
        storage: "string",
        values: DOCUMENT_TARGET_KINDS,
      },
      {
        field: "type",
        column: "relation_type",
        storage: "string",
        values: DOCUMENT_RELATION_TYPES,
      },
      { field: "description", column: "description", storage: "text" },
    ],
  },
  "session-run": {
    table: "session_runs",
    owner: "work_sessions",
    columns: [
      { field: "actor", column: "actor", storage: "string" },
      { field: "state", column: "state", storage: "string", values: historyRunStates },
      { field: "reason", column: "reason", storage: "text", nullable: true },
      { field: "operator.name", column: "operator_name", storage: "text", nullable: true },
      { field: "operator.email", column: "operator_email", storage: "text", nullable: true },
      {
        field: "operator.source",
        column: "operator_source",
        storage: "string",
        nullable: true,
        values: historyOperatorSources,
      },
      { field: "client", column: "client", storage: "text", nullable: true },
      { field: "sourceSessionId", column: "source_session_id", storage: "text", nullable: true },
      {
        field: "predecessorRunId",
        column: "predecessor_run_id",
        storage: "string",
        nullable: true,
      },
      { field: "startedAt", column: "started_at", storage: "string" },
      { field: "endedAt", column: "ended_at", storage: "string", nullable: true },
      { field: "endReason", column: "end_reason", storage: "text", nullable: true },
    ],
  },
  "document-section": {
    table: "document_sections",
    owner: "projects",
    columns: [{ field: "name", column: "name", storage: "text" }],
  },
  "section-reservation": { table: "document_section_reservations", owner: "projects", columns: [] },
  "application-participation": {
    table: "application_participations",
    owner: "applications",
    columns: [{ field: "implementationId", column: "implementation_id", storage: "string" }],
  },
  "address-assignment": {
    table: "object_keys",
    owner: "object_ids",
    columns: [{ field: "ref", column: "ref", storage: "string" }],
  },
} as const satisfies Record<
  ComponentKind,
  {
    readonly table: string;
    readonly owner: string;
    readonly columns: readonly ColumnDefinition[];
  }
>;
