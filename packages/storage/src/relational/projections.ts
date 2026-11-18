import type { EntityKind, ComponentKind } from "@relay/contracts";
import { ENTITY_DEFINITIONS } from "./entity-definitions";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import { columnsJson, columnJson } from "./columns";

/**
 * JSON raw owner строится из предметных скаляров; коллекции компонентов гидратирует прежний читатель.
 * Три производных обратных связи читаются только из их единственного источника.
 */
export function entityDataProjection(kind: EntityKind, alias = "r"): string {
  const data = columnsJson(ENTITY_DEFINITIONS[kind].columns, alias);
  switch (kind) {
    case "application":
      return `json_set(${data},
        '$.boardId',(SELECT id FROM boards WHERE application_id=${alias}.id),
        '$.prefix',(SELECT prefix FROM boards WHERE application_id=${alias}.id))`;
    case "implementation":
      return `json_set(${data},
        '$.featureId',coalesce(${alias}.feature_id,(SELECT feature_id FROM scenarios WHERE id=${alias}.scenario_id)),
        '$.targetId',coalesce(${alias}.feature_id,${alias}.scenario_id),
        '$.targetKind',CASE WHEN ${alias}.feature_id IS NOT NULL THEN 'feature' ELSE 'scenario' END,
        '$.active',json(CASE WHEN EXISTS(SELECT 1 FROM application_participations p WHERE p.owner_id=${alias}.application_id AND p.implementation_id=${alias}.id AND p.deleted=0) THEN 'true' ELSE 'false' END)
        ${", '$.scenarioId'," + alias + ".scenario_id"})`;
    case "work-session":
      return `json_set(${data},'$.currentRunId',(SELECT id FROM session_runs WHERE owner_id=${alias}.id AND state='active' AND deleted=0))`;
    case "work-checkpoint":
      return `json_set(${data},
        '$.references',json((SELECT json_group_array(json_object(
          'id',target_id,'kind',target_kind,'key',snapshot_key,
          'title',json(coalesce(snapshot_title_json,json_quote(snapshot_title))))
          ORDER BY position) FROM checkpoint_references WHERE checkpoint_id=${alias}.id)),
        '$.acceptedSessionIds',json((SELECT json_group_array(child_session_id ORDER BY position)
          FROM checkpoint_acceptances WHERE checkpoint_id=${alias}.id)))`;
    default:
      return data;
  }
}

/**
 * Одна ветвь readonly UNION владельцев; постоянный ключ берётся только из object_keys.
 */
function entityViewBranch(kind: EntityKind): string {
  const table = ENTITY_DEFINITIONS[kind].table;
  let data = entityDataProjection(kind);
  if (kind === "implementation") {
    data = `CASE WHEN r.scenario_id IS NULL THEN json_remove(${data},'$.scenarioId') ELSE ${data} END`;
  }
  return `SELECT r.id,'${kind}' AS kind,k.ref AS key,v.revision,
    r.created_at,r.updated_at,r.created_by,r.updated_by,${data} AS data
    FROM ${table} r JOIN object_keys k ON k.owner_id=r.id AND k.is_current=1 AND k.deleted=0
    JOIN local_entity_revisions v ON v.entity_id=r.id`;
}

/**
 * JSON value одной части восстанавливается из типизированных скаляров без первичного JSON-контейнера.
 */
export function componentValueProjection(kind: ComponentKind, alias = "r"): string {
  const fields = COMPONENT_DEFINITIONS[kind].columns;
  const plain = fields.filter((field) => !field.field.includes("."));
  let data = columnsJson(plain, alias);
  if (["task-criterion", "plan-stage", "session-run", "document-section"].includes(kind)) {
    data = `json_set(${data},'$.id',${alias}.id)`;
  }
  if (kind === "section-reservation") {
    return `json_object('sectionId',${alias}.id)`;
  }
  if (kind === "task-target") {
    return `json_object('targetId',coalesce(${alias}.feature_id,${alias}.scenario_id,${alias}.implementation_id))`;
  }
  if (kind === "document-relation") {
    return `json_set(${data},'$.target',json_object('id',${alias}.target_id,'kind',${alias}.target_kind))`;
  }
  if (kind === "session-run") {
    const operator = fields.filter((field) => field.field.startsWith("operator."));
    const value = `json_object(${operator
      .flatMap((field) => [`'${field.field.slice("operator.".length)}'`, columnJson(field, alias)])
      .join(",")})`;
    return `json_set(${data},'$.key','RUN-'||${alias}.id,
      '$.operator',json(CASE WHEN ${alias}.operator_source IS NULL THEN 'null' ELSE ${value} END))`;
  }
  return data;
}

/**
 * Совместимый natural key для прежнего декодера; физические ограничения используют предметные колонки.
 */
function componentIdentityProjection(kind: ComponentKind): string {
  switch (kind) {
    case "task-dependency":
      return "r.depends_on_task_id";
    case "task-related":
      return "r.related_task_id";
    case "task-target":
      return "coalesce(r.feature_id,r.scenario_id,r.implementation_id)";
    case "plan-task":
      return "json_array(r.stage_id,r.task_id)";
    case "plan-scope":
      return "json_array(r.target_kind,r.target_id)";
    case "plan-participant":
      return "coalesce(r.participant_json,json_quote(r.participant))";
    case "release-plan":
      return "r.plan_id";
    case "document-relation":
      return "json_array(r.target_id,r.relation_type)";
    case "application-participation":
      return "r.implementation_id";
    case "address-assignment":
      return "r.ref";
    default:
      return "r.id";
  }
}

/**
 * Одна ветвь readonly UNION частей с прежними узкими графовыми колонками.
 */
function componentViewBranch(kind: ComponentKind): string {
  const group = kind === "plan-task" ? "r.stage_id" : "''";
  let target = "NULL";
  if (kind === "task-dependency") {
    target = "r.depends_on_task_id";
  } else if (kind === "task-related") {
    target = "r.related_task_id";
  } else if (kind === "plan-task") {
    target = "r.task_id";
  }
  const completed =
    kind === "task-criterion" ? "CASE r.completed WHEN 1 THEN 'true' ELSE 'false' END" : "NULL";
  return `SELECT r.owner_id,'${kind}' AS kind,r.id,${componentIdentityProjection(kind)} AS identity_key,
    ${group} AS group_id,r.position,r.version,r.parents_json,r.deleted,
    ${componentValueProjection(kind)} AS value,${completed} AS completed_json,${target} AS target_id
    FROM ${COMPONENT_DEFINITIONS[kind].table} r`;
}

/**
 * Только readonly совместимость читателей; INSERT/UPDATE/DELETE и INSTEAD OF triggers отсутствуют.
 */
export const RELATIONAL_PROJECTIONS = `
  CREATE VIEW entities AS ${Object.keys(ENTITY_DEFINITIONS)
    .map((kind) => entityViewBranch(kind as EntityKind))
    .join(" UNION ALL ")};
  CREATE VIEW entity_components AS ${Object.keys(COMPONENT_DEFINITIONS)
    .map((kind) => componentViewBranch(kind as ComponentKind))
    .join(" UNION ALL ")};
  CREATE VIEW entity_refs AS SELECT ref,owner_id AS entity_id FROM object_keys WHERE deleted=0;
`;
