import { componentFields, type EntityKind } from "@relay/contracts";
import { RELATIONAL_TABLES } from "./catalog";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import { identityText, invalidRow } from "./columns";
import type { SqlRow } from "./columns.types";
import type { PortableRowIndex } from "./portable-codec.types";
import type { PortableTableMap, PortableTableRows } from "./rows.types";

const directReferences = [
  ["products", "project_id", "projects"],
  ["scenarios", "feature_id", "features"],
  ["implementations", "application_id", "applications"],
  ["implementations", "feature_id", "features"],
  ["implementations", "scenario_id", "scenarios"],
  ["boards", "application_id", "applications"],
  ["tasks", "board_id", "boards"],
  ["tasks", "parent_task_id", "tasks"],
  ["documents", "project_id", "projects"],
  ["work_plans", "project_id", "projects"],
  ["releases", "project_id", "projects"],
  ["work_sessions", "parent_session_id", "work_sessions"],
  ["checkpoints", "session_id", "work_sessions"],
  ["task_dependencies", "depends_on_task_id", "tasks"],
  ["task_relations", "related_task_id", "tasks"],
  ["task_targets", "feature_id", "features"],
  ["task_targets", "scenario_id", "scenarios"],
  ["task_targets", "implementation_id", "implementations"],
  ["plan_tasks", "task_id", "tasks"],
  ["release_plans", "plan_id", "work_plans"],
  ["application_participations", "implementation_id", "implementations"],
  ["checkpoint_references", "checkpoint_id", "checkpoints"],
  ["checkpoint_acceptances", "checkpoint_id", "checkpoints"],
  ["checkpoint_acceptances", "child_session_id", "work_sessions"],
  ["task_comments", "task_id", "tasks"],
  ["replication_entity_versions", "entity_id", "object_ids"],
] as const;

/**
 * Индексирует один полный набор и проверяет идентичности, FK и однозначность производных полей.
 * Обход линейный по числу строк и связей; предметные переходы, digest и циклы Core не вычисляются.
 */
export function indexPortableRows(input: PortableTableRows): PortableRowIndex {
  const tables = new Map<keyof PortableTableMap, Map<string, Readonly<SqlRow>>>();
  const entities = new Map<string, Readonly<SqlRow>>();
  const kinds = new Map<string, EntityKind>(
    input.tables.object_ids.map((row) => [row.id, row.kind]),
  );
  for (const table of RELATIONAL_TABLES) {
    if (
      !table.portable ||
      table.name === "local_entity_revisions" ||
      table.name === "local_comment_sequences"
    ) {
      continue;
    }
    const rows = new Map<string, Readonly<SqlRow>>();
    for (const entry of input.tables[table.name]) {
      const row: SqlRow = { ...entry };
      rows.set(JSON.stringify(table.primaryKey.map((field) => row[field])), row);
      if (table.entityKind !== undefined) {
        const id = identityText(row.id, "id");
        if (entities.has(id) || kinds.get(id) !== table.entityKind) {
          invalidRow("object_ids.kind");
        }
        entities.set(id, row);
      }
    }
    tables.set(table.name, rows);
  }
  const index: PortableRowIndex = {
    tables,
    entities,
    kinds,
    keys: currentKeys(input.tables),
    boards: applicationBoards(input.tables),
    runs: currentRuns(input.tables),
    activeImplementations: new Set(
      input.tables.application_participations
        .filter((row) => row.deleted === 0)
        .map((row) => row.implementation_id),
    ),
  };
  if (
    entities.size !== kinds.size ||
    input.tables.projects.length !== 1 ||
    input.tables.projects[0]?.id !== input.projectId ||
    input.tables.replication_entity_versions.length !== entities.size ||
    index.keys.size !== entities.size ||
    input.tables.replication_publications.length > 1
  ) {
    invalidRow("snapshot.identity");
  }
  assertReferences(index);
  assertScopedReferences(input.tables, index);
  assertHistoryPositions(input.tables);
  assertCommentOrder(input.tables);
  return index;
}

/**
 * Получает строку по постоянному простому либо составному PK; отсутствие — повреждённый FK.
 */
export function requirePortableRow(
  index: PortableRowIndex,
  table: keyof PortableTableMap,
  key: readonly (string | number | null | undefined)[],
): Readonly<SqlRow> {
  const row = index.tables.get(table)?.get(JSON.stringify(key));
  return row ?? invalidRow(`${table}.foreignKey`);
}

/**
 * Проверяет все прямые FK и соответствие известных владельцев таблицам компонентов.
 */
function assertReferences(index: PortableRowIndex): void {
  for (const [table, column, target] of directReferences) {
    for (const row of index.tables.get(table)?.values() ?? []) {
      if (row[column] !== null) {
        requirePortableRow(index, target, [row[column]]);
      }
    }
  }
  for (const table of RELATIONAL_TABLES) {
    if (
      table.componentKind === undefined ||
      table.name === "local_entity_revisions" ||
      table.name === "local_comment_sequences"
    ) {
      continue;
    }
    const owner = COMPONENT_DEFINITIONS[table.componentKind].owner;
    for (const row of index.tables.get(table.name)?.values() ?? []) {
      requirePortableRow(index, owner, [row.owner_id]);
      if (table.componentKind === "collection") {
        const kind = index.kinds.get(identityText(row.owner_id, "owner_id"));
        if (kind === undefined || !componentFields(kind).some((field) => field === row.field)) {
          invalidRow("collection.owner");
        }
      }
    }
  }
}

/**
 * Проверяет scoped FK истории/составов и полиморфные ссылки с явным matching kind.
 */
function assertScopedReferences(tables: PortableTableMap, index: PortableRowIndex): void {
  for (const row of [
    ...tables.plan_scopes,
    ...tables.document_relations,
    ...tables.checkpoint_references,
  ]) {
    if (index.kinds.get(row.target_id) !== row.target_kind) {
      invalidRow("target_kind");
    }
  }
  for (const row of tables.documents) {
    if (row.section_id !== null) {
      requirePortableRow(index, "document_sections", [row.project_id, row.section_id]);
    }
  }
  for (const row of tables.plan_tasks) {
    requirePortableRow(index, "plan_stages", [row.owner_id, row.stage_id]);
  }
  for (const row of tables.application_participations) {
    if (
      requirePortableRow(index, "implementations", [row.implementation_id]).application_id !==
      row.owner_id
    ) {
      invalidRow("application_participations.owner_id");
    }
  }
  for (const row of tables.session_runs) {
    if (row.predecessor_run_id !== null) {
      requirePortableRow(index, "session_runs", [row.owner_id, row.predecessor_run_id]);
    }
  }
  for (const row of tables.checkpoints) {
    requirePortableRow(index, "session_runs", [row.session_id, row.run_id]);
    if (
      row.intent_id !== null &&
      requirePortableRow(index, "checkpoints", [row.intent_id]).session_id !== row.session_id
    ) {
      invalidRow("checkpoints.intent_id");
    }
  }
  for (const row of tables.work_sessions) {
    if (row.parent_session_id === null) {
      if (row.origin_checkpoint_id !== null || row.created_by_run_id !== null) {
        invalidRow("work_sessions.parent_session_id");
      }
      continue;
    }
    if (
      requirePortableRow(index, "checkpoints", [row.origin_checkpoint_id]).session_id !==
      row.parent_session_id
    ) {
      invalidRow("work_sessions.origin_checkpoint_id");
    }
    requirePortableRow(index, "session_runs", [row.parent_session_id, row.created_by_run_id]);
  }
}

/**
 * Восстанавливает текущие ключи из активных адресных назначений; tombstones не становятся адресами.
 */
function currentKeys(tables: PortableTableMap): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const refs = new Map<string, string>();
  for (const row of tables.object_keys) {
    if (row.deleted === 0) {
      if (refs.has(row.ref)) {
        invalidRow("object_keys.ref");
      }
      refs.set(row.ref, row.owner_id);
    }
    if (row.is_current === 1) {
      if (row.deleted !== 0 || result.has(row.owner_id)) {
        invalidRow("object_keys.is_current");
      }
      result.set(row.owner_id, row.ref);
    }
  }
  for (const row of tables.object_ids) {
    if (refs.get(row.id) !== row.id || !result.has(row.id)) {
      invalidRow("object_keys.owner_id");
    }
  }
  return result;
}

/**
 * Строит обратную связь приложения с его единственной доской без дублирования prefix.
 */
function applicationBoards(tables: PortableTableMap): ReadonlyMap<string, Readonly<SqlRow>> {
  const result = new Map<string, Readonly<SqlRow>>();
  for (const row of tables.boards) {
    if (row.application_id !== null) {
      if (result.has(row.application_id)) {
        invalidRow("boards.application_id");
      }
      result.set(row.application_id, { ...row });
    }
  }
  for (const row of tables.applications) {
    if (!result.has(row.id)) {
      invalidRow("applications.boardId");
    }
  }
  return result;
}

/**
 * Выводит currentRunId только из единственного действующего active run владельца.
 */
function currentRuns(tables: PortableTableMap): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const row of tables.session_runs) {
    if (row.deleted === 0 && row.state === "active") {
      if (result.has(row.owner_id)) {
        invalidRow("session_runs.active");
      }
      result.set(row.owner_id, row.id);
    }
  }
  return result;
}

/**
 * Защищает исходный порядок исторических массивов от повторных и пропущенных позиций.
 */
function assertHistoryPositions(tables: PortableTableMap): void {
  for (const rows of [tables.checkpoint_references, tables.checkpoint_acceptances]) {
    const positions = new Map<string, Set<number>>();
    for (const row of rows) {
      const values = positions.get(row.checkpoint_id) ?? new Set<number>();
      if (values.has(row.position)) {
        invalidRow("checkpoint.position");
      }
      values.add(row.position);
      positions.set(row.checkpoint_id, values);
    }
    for (const values of positions.values()) {
      for (let position = 0; position < values.size; position++) {
        if (!values.has(position)) {
          invalidRow("checkpoint.position");
        }
      }
    }
  }
}

/**
 * Проверяет принадлежность predecessor комментария той же задаче и отсутствие циклов журнала.
 */
function assertCommentOrder(tables: PortableTableMap): void {
  const comments = new Map(tables.task_comments.map((row) => [row.id, row]));
  const visited = new Set<string>();
  for (const start of comments.values()) {
    const chain = new Set<string>();
    let row: typeof start | undefined = start;
    while (row !== undefined && !visited.has(row.id)) {
      if (chain.has(row.id)) {
        invalidRow("task_comments.after_id");
      }
      chain.add(row.id);
      if (row.after_id === null) {
        break;
      }
      row = comments.get(row.after_id);
      if (row === undefined || row.task_id !== start.task_id) {
        invalidRow("task_comments.after_id");
      }
    }
    for (const id of chain) {
      visited.add(id);
    }
  }
}
