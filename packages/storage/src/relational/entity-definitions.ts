import {
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  IMPLEMENTATION_STATUSES,
  PLAN_STATUSES,
  RELEASE_STATUSES,
  TASK_COLUMNS,
  historyCheckpointKinds,
  historySessionStatuses,
  type EntityKind,
} from "@relay/contracts";
import type { ColumnDefinition } from "./columns.types";

/**
 * Физические таблицы владельцев: здесь только предметные скаляры без ключа и local CAS.
 * Связи, выводимые из других таблиц, добавляются при построении совместимой проекции.
 */
export const ENTITY_DEFINITIONS = {
  project: {
    table: "projects",
    columns: [
      { field: "name", column: "name", storage: "text" },
      { field: "slug", column: "slug", storage: "string" },
    ],
  },
  product: {
    table: "products",
    columns: [
      { field: "name", column: "name", storage: "text", optional: true },
      { field: "summary", column: "summary", storage: "text", optional: true },
      { field: "description", column: "description", storage: "text", optional: true },
    ],
  },
  feature: {
    table: "features",
    columns: [
      { field: "name", column: "name", storage: "text" },
      { field: "summary", column: "summary", storage: "text" },
      { field: "description", column: "description", storage: "text" },
    ],
  },
  scenario: {
    table: "scenarios",
    columns: [
      { field: "featureId", column: "feature_id", storage: "string" },
      { field: "name", column: "name", storage: "text" },
      { field: "summary", column: "summary", storage: "text" },
      { field: "description", column: "description", storage: "text" },
    ],
  },
  application: {
    table: "applications",
    columns: [
      { field: "name", column: "name", storage: "text" },
      { field: "summary", column: "summary", storage: "text" },
      { field: "description", column: "description", storage: "text" },
      { field: "slug", column: "slug", storage: "string" },
      { field: "type", column: "type", storage: "string", values: APPLICATION_TYPES },
    ],
  },
  implementation: {
    table: "implementations",
    columns: [
      { field: "title", column: "title", storage: "text" },
      { field: "description", column: "description", storage: "text" },
      { field: "status", column: "status", storage: "string", values: IMPLEMENTATION_STATUSES },
      { field: "applicationId", column: "application_id", storage: "string" },
    ],
  },
  board: {
    table: "boards",
    columns: [
      { field: "name", column: "name", storage: "text" },
      { field: "slug", column: "slug", storage: "string" },
      { field: "prefix", column: "prefix", storage: "string" },
      { field: "description", column: "description", storage: "text", optional: true },
      { field: "applicationId", column: "application_id", storage: "string", optional: true },
    ],
  },
  task: {
    table: "tasks",
    columns: [
      { field: "boardId", column: "board_id", storage: "string" },
      { field: "title", column: "title", storage: "text" },
      { field: "description", column: "description", storage: "text" },
      { field: "column", column: "column", storage: "string", values: TASK_COLUMNS },
      { field: "parentId", column: "parent_task_id", storage: "string", nullable: true },
    ],
  },
  document: {
    table: "documents",
    columns: [
      { field: "name", column: "name", storage: "text" },
      { field: "summary", column: "summary", storage: "text" },
      { field: "body", column: "body", storage: "text" },
      { field: "documentKind", column: "document_kind", storage: "string", values: DOCUMENT_KINDS },
      {
        field: "documentStatus",
        column: "document_status",
        storage: "string",
        values: DOCUMENT_STATUSES,
      },
      { field: "sectionId", column: "section_id", storage: "string", nullable: true },
      { field: "pinned", column: "pinned", storage: "boolean" },
    ],
  },
  "work-plan": {
    table: "work_plans",
    columns: [
      { field: "projectId", column: "project_id", storage: "string" },
      { field: "title", column: "title", storage: "text" },
      { field: "summary", column: "summary", storage: "text" },
      { field: "goal", column: "goal", storage: "text" },
      { field: "rationale", column: "rationale", storage: "text" },
      { field: "boundaries", column: "boundaries", storage: "text" },
      { field: "expectedResult", column: "expected_result", storage: "text" },
      { field: "result", column: "result", storage: "text" },
      { field: "status", column: "status", storage: "string", values: PLAN_STATUSES },
      { field: "startedAt", column: "started_at", storage: "string", nullable: true },
      { field: "closedAt", column: "closed_at", storage: "string", nullable: true },
    ],
  },
  release: {
    table: "releases",
    columns: [
      { field: "projectId", column: "project_id", storage: "string" },
      { field: "title", column: "title", storage: "text" },
      { field: "version", column: "release_version", storage: "text" },
      { field: "summary", column: "summary", storage: "text" },
      { field: "description", column: "description", storage: "text" },
      { field: "plannedFor", column: "planned_for", storage: "string" },
      { field: "status", column: "status", storage: "string", values: RELEASE_STATUSES },
      { field: "releasedAt", column: "released_at", storage: "string", nullable: true },
      { field: "releasedBy", column: "released_by", storage: "string", nullable: true },
    ],
  },
  "work-session": {
    table: "work_sessions",
    columns: [
      { field: "title", column: "title", storage: "text" },
      { field: "description", column: "description", storage: "text", nullable: true },
      { field: "status", column: "status", storage: "string", values: historySessionStatuses },
      { field: "parentSessionId", column: "parent_session_id", storage: "string", nullable: true },
      {
        field: "originCheckpointId",
        column: "origin_checkpoint_id",
        storage: "string",
        nullable: true,
      },
      { field: "createdByRunId", column: "created_by_run_id", storage: "string", nullable: true },
      { field: "result", column: "result", storage: "text", nullable: true },
      { field: "closedAt", column: "closed_at", storage: "string", nullable: true },
    ],
  },
  "work-checkpoint": {
    table: "checkpoints",
    columns: [
      {
        field: "kind",
        column: "checkpoint_kind",
        storage: "string",
        values: historyCheckpointKinds,
      },
      { field: "sessionId", column: "session_id", storage: "string" },
      { field: "runId", column: "run_id", storage: "string" },
      { field: "actor", column: "actor", storage: "string" },
      { field: "intentId", column: "intent_id", storage: "string", nullable: true },
      { field: "sequence", column: "sequence", storage: "integer" },
      { field: "sessionRevision", column: "session_revision", storage: "integer" },
      { field: "title", column: "title", storage: "text" },
      { field: "body", column: "body", storage: "text" },
      { field: "summary", column: "summary", storage: "text", nullable: true },
      { field: "done", column: "done", storage: "text", nullable: true },
      { field: "remaining", column: "remaining", storage: "text", nullable: true },
      { field: "nextStep", column: "next_step", storage: "text", nullable: true },
      { field: "checks", column: "checks", storage: "text", nullable: true },
    ],
  },
} as const satisfies Record<
  EntityKind,
  { readonly table: string; readonly columns: readonly ColumnDefinition[] }
>;
