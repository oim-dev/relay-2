import { componentFields, ENTITY_KINDS, type ComponentKind } from "@relay/contracts";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import { columnNames, columnsDdl } from "./columns";
import { relationalMessages } from "./relational.messages";

const deferred = "DEFERRABLE INITIALLY DEFERRED";
const importDisabled = "(SELECT importing FROM replication_state WHERE singleton=1)=0";
const additional: Readonly<Partial<Record<ComponentKind, readonly string[]>>> = {
  collection: ["CHECK(id=field)"],
  "task-criterion": [
    "CHECK((completed=0 AND completed_at IS NULL AND completed_by IS NULL) OR (completed=1 AND completed_at IS NOT NULL AND completed_by IS NOT NULL))",
  ],
  "task-dependency": [
    `FOREIGN KEY(depends_on_task_id) REFERENCES tasks(id) ${deferred}`,
    "CHECK(owner_id!=depends_on_task_id)",
  ],
  "task-related": [
    `FOREIGN KEY(related_task_id) REFERENCES tasks(id) ${deferred}`,
    "CHECK(owner_id!=related_task_id)",
  ],
  "task-target": [
    `feature_id TEXT REFERENCES features(id) ${deferred}`,
    `scenario_id TEXT REFERENCES scenarios(id) ${deferred}`,
    `implementation_id TEXT REFERENCES implementations(id) ${deferred}`,
    "CHECK((feature_id IS NOT NULL)+(scenario_id IS NOT NULL)+(implementation_id IS NOT NULL)=1)",
  ],
  "plan-task": [
    `FOREIGN KEY(owner_id,stage_id) REFERENCES plan_stages(owner_id,id) ${deferred}`,
    `FOREIGN KEY(task_id) REFERENCES tasks(id) ${deferred}`,
  ],
  "plan-scope": [`FOREIGN KEY(target_id,target_kind) REFERENCES object_ids(id,kind) ${deferred}`],
  "release-plan": [`FOREIGN KEY(plan_id) REFERENCES work_plans(id) ${deferred}`],
  "document-relation": [
    `FOREIGN KEY(target_id,target_kind) REFERENCES object_ids(id,kind) ${deferred}`,
    "CHECK(owner_id!=target_id)",
  ],
  "session-run": [
    `FOREIGN KEY(owner_id,predecessor_run_id) REFERENCES session_runs(owner_id,id) ${deferred}`,
    "CHECK(predecessor_run_id IS NULL OR predecessor_run_id!=id)",
    "CHECK(deleted=0)",
    "CHECK((state='active' AND ended_at IS NULL AND end_reason IS NULL AND end_reason_json IS NULL) OR (state!='active' AND ended_at IS NOT NULL AND (end_reason IS NOT NULL OR end_reason_json IS NOT NULL)))",
    "CHECK(operator_source IS NOT NULL OR (operator_name IS NULL AND operator_name_json IS NULL AND operator_email IS NULL AND operator_email_json IS NULL))",
  ],
  "section-reservation": ["CHECK(deleted=0)"],
  "application-participation": [
    `FOREIGN KEY(owner_id,implementation_id) REFERENCES implementations(application_id,id) ${deferred}`,
  ],
  "address-assignment": [
    "is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1))",
    "CHECK(length(ref)>0)",
    "CHECK(is_current=0 OR (deleted=0 AND instr(ref,':')=0))",
  ],
};

const immutableValueKinds: readonly ComponentKind[] = [
  "collection",
  "task-dependency",
  "task-related",
  "task-target",
  "plan-task",
  "plan-scope",
  "plan-participant",
  "release-plan",
  "section-reservation",
  "application-participation",
  "address-assignment",
];

/**
 * Создаёт таблицу одного вида частей и защищает неизменяемую идентичность назначения.
 * События/outbox принадлежат вызывающему механизму записи, а не этим предметным триггерам.
 */
function componentTable(kind: ComponentKind): string {
  const definition = COMPONENT_DEFINITIONS[kind];
  const columns = [...columnsDdl(definition.columns), ...(additional[kind] ?? [])];
  let orderColumns = "owner_id,deleted,position,id";
  let orderIndex = `${definition.table}_order`;
  if (kind === "task-criterion") {
    orderColumns += ",completed";
    orderIndex = "task_criteria_graph";
  } else if (kind === "task-dependency") {
    orderColumns += ",depends_on_task_id";
    orderIndex = "task_dependencies_graph";
  }
  const immutable = ["owner_id", "id"];
  if (immutableValueKinds.includes(kind)) {
    immutable.push(...columnNames(definition.columns));
    if (kind === "task-target") {
      immutable.push("feature_id", "scenario_id", "implementation_id");
    }
  } else if (kind === "document-relation") {
    immutable.push("target_id", "target_kind", "relation_type");
  }
  let immutableCondition = immutable
    .map((field) => `NEW.${field} IS NOT OLD.${field}`)
    .join(" OR ");
  if (kind === "session-run") {
    const fields = columnNames(definition.columns);
    const mutable = new Set(["state", "ended_at", "end_reason", "end_reason_json"]);
    immutableCondition +=
      " OR " +
      fields
        .filter((field) => !mutable.has(field))
        .map((field) => `NEW.${field} IS NOT OLD.${field}`)
        .join(" OR ");
    immutableCondition += ` OR (OLD.state!='active' AND ${importDisabled} AND (NEW.position IS NOT OLD.position OR ${fields.map((field) => `NEW.${field} IS NOT OLD.${field}`).join(" OR ")}))`;
  }
  return `
    CREATE TABLE ${definition.table} (
      owner_id TEXT NOT NULL REFERENCES ${definition.owner}(id) ${deferred},
      id TEXT NOT NULL CHECK(length(id)>0),
      position TEXT NOT NULL CHECK(length(position)>0),
      version TEXT NOT NULL CHECK(length(version)=64 AND version NOT GLOB '*[^0-9a-f]*'),
      parents_json TEXT NOT NULL CHECK(json_valid(parents_json) AND json_type(parents_json)='array'),
      deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
      ${columns.length ? columns.join(",") + "," : ""}
      PRIMARY KEY(owner_id,id)
    ) STRICT;
    CREATE INDEX ${orderIndex} ON ${definition.table}(${orderColumns});
    CREATE TRIGGER ${definition.table}_immutable BEFORE UPDATE ON ${definition.table}
    WHEN ${immutableCondition}
    BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutableHistory}'); END;
    CREATE TRIGGER ${definition.table}_no_delete BEFORE DELETE ON ${definition.table}
    WHEN ${importDisabled}
    BEGIN SELECT RAISE(ABORT,'${relationalMessages.importRequired}'); END;
    ${
      kind === "collection"
        ? ""
        : `CREATE TRIGGER ${definition.table}_no_revive BEFORE UPDATE ON ${definition.table}
    WHEN OLD.deleted=1 AND NEW.deleted=0 AND ${importDisabled}
    BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutableHistory}'); END;`
    }
  `;
}

/**
 * Самостоятельные предметные строки с уникальностью действующих включений и прямыми FK.
 */
export const COMPONENT_SCHEMA =
  Object.keys(COMPONENT_DEFINITIONS)
    .map((kind) => componentTable(kind as ComponentKind))
    .join("\n") +
  `
  CREATE TRIGGER component_collections_owner BEFORE INSERT ON component_collections
  WHEN NOT EXISTS(SELECT 1 FROM object_ids WHERE id=NEW.owner_id AND (
    ${ENTITY_KINDS.filter((kind) => componentFields(kind).length > 0)
      .map(
        (kind) =>
          `(kind='${kind}' AND NEW.field IN (${componentFields(kind)
            .map((field) => `'${field}'`)
            .join(",")}))`,
      )
      .join(" OR ")}
  ))
  BEGIN SELECT RAISE(ABORT,'${relationalMessages.shape}'); END;
  CREATE UNIQUE INDEX task_dependencies_active ON task_dependencies(owner_id,depends_on_task_id) WHERE deleted=0;
  CREATE INDEX task_dependencies_reverse ON task_dependencies(depends_on_task_id,deleted,owner_id);
  CREATE UNIQUE INDEX task_relations_active ON task_relations(owner_id,related_task_id) WHERE deleted=0;
  CREATE UNIQUE INDEX task_targets_feature ON task_targets(owner_id,feature_id) WHERE deleted=0 AND feature_id IS NOT NULL;
  CREATE UNIQUE INDEX task_targets_scenario ON task_targets(owner_id,scenario_id) WHERE deleted=0 AND scenario_id IS NOT NULL;
  CREATE UNIQUE INDEX task_targets_implementation ON task_targets(owner_id,implementation_id) WHERE deleted=0 AND implementation_id IS NOT NULL;
  CREATE UNIQUE INDEX plan_tasks_active ON plan_tasks(owner_id,task_id) WHERE deleted=0;
  CREATE INDEX plan_tasks_task ON plan_tasks(task_id,deleted,owner_id);
  CREATE INDEX plan_tasks_stage ON plan_tasks(owner_id,stage_id,deleted,position,id);
  CREATE UNIQUE INDEX plan_scopes_active ON plan_scopes(owner_id,target_id) WHERE deleted=0;
  CREATE UNIQUE INDEX plan_participants_active ON plan_participants(owner_id,coalesce(participant_json,json_quote(participant))) WHERE deleted=0;
  CREATE UNIQUE INDEX release_plans_active ON release_plans(owner_id,plan_id) WHERE deleted=0;
  CREATE UNIQUE INDEX document_relations_active ON document_relations(owner_id,target_id,relation_type) WHERE deleted=0;
  CREATE INDEX document_relations_target ON document_relations(target_id,relation_type,deleted,owner_id);
  CREATE UNIQUE INDEX session_runs_active ON session_runs(owner_id) WHERE state='active' AND deleted=0;
  CREATE UNIQUE INDEX application_participations_active ON application_participations(owner_id,implementation_id) WHERE deleted=0;
  CREATE UNIQUE INDEX object_keys_active_ref ON object_keys(ref) WHERE deleted=0;
  CREATE UNIQUE INDEX object_keys_current ON object_keys(owner_id) WHERE is_current=1;
  CREATE INDEX object_keys_owner_ref ON object_keys(owner_id,ref,deleted);
`;
