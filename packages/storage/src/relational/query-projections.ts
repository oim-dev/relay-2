import type { EntityKind } from "@relay/contracts";
import { ENTITY_DEFINITIONS } from "./entity-definitions";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import { columnJson, columnsJson } from "./columns";
import { componentValueProjection } from "./projections";

const kinds = Object.keys(ENTITY_DEFINITIONS) as EntityKind[];

/**
 * Присоединяет только адрес и local CAS к известной предметной таблице без повторного общего UNION.
 */
function ownerSelect(kind: EntityKind, columns: readonly string[] = []): string {
  return `SELECT r.id,'${kind}' AS kind,k.ref AS key,v.revision,
    r.created_at,r.updated_at,r.created_by,r.updated_by${columns.length === 0 ? "" : "," + columns.join(",")}
    FROM ${ENTITY_DEFINITIONS[kind].table} r
    JOIN object_keys k ON k.owner_id=r.id AND k.is_current=1 AND k.deleted=0
    JOIN local_entity_revisions v ON v.entity_id=r.id`;
}

/**
 * Строит JSON только выбранных скаляров первичной таблицы, без полного data и его последующего удаления.
 */
function selectedData(kind: EntityKind, fields: readonly string[], alias = "r"): string {
  return columnsJson(
    ENTITY_DEFINITIONS[kind].columns.filter((field) => fields.includes(field.field)),
    alias,
  );
}

/**
 * Выражает присутствующую коллекцию через узкие строки; отсутствие декларации остаётся явным null.
 */
function collection(field: string, table: string, value: string): string {
  let covering = "";
  if (table === "task_dependencies") {
    covering = " INDEXED BY task_dependencies_graph";
  } else if (table === "task_criteria") {
    covering = " INDEXED BY task_criteria_graph";
  }
  return `json(CASE WHEN EXISTS(SELECT 1 FROM component_collections
    WHERE owner_id=r.id AND field='${field}' AND deleted=0)
    THEN (SELECT json_group_array(${value} ORDER BY c.position,c.id) FROM ${table} c${covering} WHERE c.owner_id=r.id AND c.deleted=0)
    ELSE 'null' END)`;
}

/**
 * Узкая проекция одного участия для timeline: причины подключения/завершения не считываются.
 */
function runHeaderProjection(): string {
  const fields = COMPONENT_DEFINITIONS["session-run"].columns.filter(
    (field) =>
      !["reason", "endReason"].includes(field.field) && !field.field.startsWith("operator."),
  );
  const operator = COMPONENT_DEFINITIONS["session-run"].columns.filter((field) =>
    field.field.startsWith("operator."),
  );
  return `json_set(${columnsJson(fields, "c")},'$.id',c.id,'$.key','RUN-'||c.id,
    '$.operator',json(CASE WHEN c.operator_source IS NULL THEN 'null' ELSE
      json_object(${operator.flatMap((field) => [`'${field.field.slice("operator.".length)}'`, columnJson(field, "c")]).join(",")}) END))`;
}

/**
 * Узкая проекция связей владельца для графа; тексты документов, критериев, этапов и журнал исключены.
 */
function relationData(kind: EntityKind): string {
  switch (kind) {
    case "project":
      return selectedData(kind, ["name", "slug"]);
    case "product":
      return selectedData(kind, ["name"]);
    case "feature":
      return selectedData(kind, ["name"]);
    case "scenario":
      return selectedData(kind, ["name", "featureId"]);
    case "board":
      return selectedData(kind, ["name", "slug", "prefix", "applicationId"]);
    case "application":
      return `json_set(${selectedData(kind, ["name", "slug", "type"])},
        '$.boardId',(SELECT id FROM boards WHERE application_id=r.id),
        '$.prefix',(SELECT prefix FROM boards WHERE application_id=r.id),
        '$.implementationIds',${collection("implementationIds", "application_participations", "c.implementation_id")})`;
    case "implementation":
      return `json_set(${selectedData(kind, ["title", "status", "applicationId"])},
        '$.targetId',coalesce(r.feature_id,r.scenario_id),
        '$.targetKind',CASE WHEN r.feature_id IS NOT NULL THEN 'feature' ELSE 'scenario' END,
        '$.active',json(CASE WHEN EXISTS(SELECT 1 FROM application_participations p WHERE p.owner_id=r.application_id AND p.implementation_id=r.id AND p.deleted=0) THEN 'true' ELSE 'false' END))`;
    case "task":
      return `json_set(${selectedData(kind, ["boardId", "title", "column", "parentId"])},
        '$.dependencies',${collection("dependencies", "task_dependencies", "c.depends_on_task_id")},
        '$.related',${collection("related", "task_relations", "c.related_task_id")},
        '$.targets',${collection("targets", "task_targets", "coalesce(c.feature_id,c.scenario_id,c.implementation_id)")})`;
    case "document":
      return `json_set(${selectedData(kind, ["name", "documentKind", "documentStatus", "sectionId", "pinned"])},
        '$.relations',${collection("relations", "document_relations", componentValueProjection("document-relation", "c"))})`;
    case "work-plan": {
      const stage = `json_object('id',c.id,'title',json(coalesce(c.title_json,json_quote(c.title))),
        'taskIds',json((SELECT json_group_array(task_id ORDER BY position,id) FROM plan_tasks WHERE owner_id=r.id AND stage_id=c.id AND deleted=0)))`;
      return `json_set(${selectedData(kind, ["projectId", "title", "status", "startedAt", "closedAt"])},
        '$.scope',${collection("scope", "plan_scopes", "json_object('id',c.target_id,'kind',c.target_kind)")},
        '$.stages',${collection("stages", "plan_stages", stage)})`;
    }
    case "release":
      return `json_set(${selectedData(kind, ["projectId", "title", "version", "status", "plannedFor", "releasedAt", "releasedBy"])},
        '$.planIds',${collection("planIds", "release_plans", "c.plan_id")})`;
    case "work-session":
      return selectedData(kind, [
        "title",
        "status",
        "parentSessionId",
        "originCheckpointId",
        "createdByRunId",
        "closedAt",
      ]);
    case "work-checkpoint":
      return `json_set(${selectedData(kind, ["title", "kind", "sessionId", "runId", "actor", "intentId", "sequence", "sessionRevision"])},
        '$.references',json((SELECT json_group_array(json_object('id',target_id,'kind',target_kind) ORDER BY position)
          FROM checkpoint_references WHERE checkpoint_id=r.id)),
        '$.acceptedSessionIds',json((SELECT json_group_array(child_session_id ORDER BY position)
          FROM checkpoint_acceptances WHERE checkpoint_id=r.id)))`;
  }
}

/**
 * Одна metadata-only ветвь summary; SQLite не строит полный JSON содержания даже для фильтрации.
 */
function summaryBranch(kind: EntityKind): string {
  const definition = ENTITY_DEFINITIONS[kind];
  const name = definition.columns.find(
    (field) => field.field === "name" || field.field === "title",
  );
  const state = definition.columns.find((field) =>
    ["status", "column", "documentStatus"].includes(field.field),
  );
  const title =
    name === undefined
      ? "NULL"
      : `CASE WHEN r.${name.column} IS NULL AND r.${name.column}_json IS NULL THEN NULL ELSE coalesce(r.${name.column}_json,json_quote(r.${name.column})) END`;
  const active =
    kind !== "implementation"
      ? "NULL"
      : "CASE WHEN EXISTS(SELECT 1 FROM application_participations p WHERE p.owner_id=r.application_id AND p.implementation_id=r.id AND p.deleted=0) THEN 'true' ELSE 'false' END";
  return ownerSelect(kind, [
    `${title} AS title`,
    `${state === undefined ? "NULL" : `json_quote(r.${state.column})`} AS state`,
    `${active} AS active`,
  ]);
}

/**
 * Идентичности, summaries и графы читают первичные скаляры напрямую.
 * Ни одна ветвь не обращается к entities.data и не собирает полный Markdown для последующего json_remove.
 */
export const QUERY_PROJECTIONS = `
  CREATE VIEW entity_identities AS
    SELECT o.id,o.kind,k.ref AS key,v.revision FROM object_ids o
    JOIN object_keys k ON k.owner_id=o.id AND k.is_current=1 AND k.deleted=0
    JOIN local_entity_revisions v ON v.entity_id=o.id;
  CREATE VIEW entity_headers AS ${kinds.map((kind) => ownerSelect(kind)).join(" UNION ALL ")};
  CREATE VIEW entity_summaries AS ${kinds.map(summaryBranch).join(" UNION ALL ")};
  CREATE VIEW task_graph_sources AS ${ownerSelect("task", [
    `json_object('column',r.column,'parentId',r.parent_task_id,
      'dependencies',${collection("dependencies", "task_dependencies", "c.depends_on_task_id")},
      'acceptanceCriteria',${collection("acceptanceCriteria", "task_criteria", "json_object('completed',json(CASE c.completed WHEN 1 THEN 'true' ELSE 'false' END))")})
      AS data`,
    "NULL AS comments",
  ])};
  CREATE VIEW relation_graph_sources AS ${kinds
    .map((kind) => ownerSelect(kind, [`${relationData(kind)} AS data`, "NULL AS comments"]))
    .join(" UNION ALL ")};
  CREATE VIEW history_graph_sources AS
    ${ownerSelect("work-session", [
      `json_set(${selectedData("work-session", ["title", "status", "parentSessionId", "originCheckpointId", "createdByRunId", "closedAt"])},
      '$.currentRunId',(SELECT id FROM session_runs WHERE owner_id=r.id AND state='active' AND deleted=0),
      '$.runs',${collection("runs", "session_runs", runHeaderProjection())}) AS data`,
      "NULL AS comments",
    ])}
    UNION ALL
    ${ownerSelect("work-checkpoint", [
      `${selectedData("work-checkpoint", ["kind", "sessionId", "runId", "actor", "intentId", "sequence", "sessionRevision", "title", "summary"])} AS data`,
      "NULL AS comments",
    ])};
`;
