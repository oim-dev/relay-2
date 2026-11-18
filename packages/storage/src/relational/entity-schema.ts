import { ENTITY_KINDS, type EntityKind } from "@relay/contracts";
import { ENTITY_DEFINITIONS } from "./entity-definitions";
import { columnNames, columnsDdl } from "./columns";
import { relationalMessages } from "./relational.messages";

const deferred = "DEFERRABLE INITIALLY DEFERRED";
const metadata = `
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0) REFERENCES object_ids(id) ${deferred},
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL`;

const additional: Readonly<Partial<Record<EntityKind, readonly string[]>>> = {
  product: [`project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ${deferred}`],
  scenario: [`FOREIGN KEY(feature_id) REFERENCES features(id) ${deferred}`],
  implementation: [
    "feature_id TEXT",
    "scenario_id TEXT",
    "CHECK((feature_id IS NOT NULL)+(scenario_id IS NOT NULL)=1)",
    `FOREIGN KEY(application_id) REFERENCES applications(id) ${deferred}`,
    `FOREIGN KEY(feature_id) REFERENCES features(id) ${deferred}`,
    `FOREIGN KEY(scenario_id) REFERENCES scenarios(id) ${deferred}`,
    "UNIQUE(application_id,id)",
  ],
  board: [`FOREIGN KEY(application_id) REFERENCES applications(id) ${deferred}`],
  task: [
    `FOREIGN KEY(board_id) REFERENCES boards(id) ${deferred}`,
    `FOREIGN KEY(parent_task_id) REFERENCES tasks(id) ${deferred}`,
    "CHECK(parent_task_id IS NULL OR parent_task_id!=id)",
  ],
  document: [
    `project_id TEXT NOT NULL REFERENCES projects(id) ${deferred}`,
    `FOREIGN KEY(project_id,section_id) REFERENCES document_sections(owner_id,id) ${deferred}`,
  ],
  "work-plan": [
    `FOREIGN KEY(project_id) REFERENCES projects(id) ${deferred}`,
    "CHECK((status IN ('completed','cancelled'))=(closed_at IS NOT NULL))",
    "CHECK(status!='active' OR started_at IS NOT NULL)",
    "CHECK(status!='draft' OR started_at IS NULL)",
  ],
  release: [
    `FOREIGN KEY(project_id) REFERENCES projects(id) ${deferred}`,
    "CHECK((status='released')=(released_at IS NOT NULL AND released_by IS NOT NULL))",
    "CHECK((released_at IS NULL)=(released_by IS NULL))",
  ],
  "work-session": [
    `FOREIGN KEY(parent_session_id) REFERENCES work_sessions(id) ${deferred}`,
    `FOREIGN KEY(parent_session_id,origin_checkpoint_id) REFERENCES checkpoints(session_id,id) ${deferred}`,
    `FOREIGN KEY(parent_session_id,created_by_run_id) REFERENCES session_runs(owner_id,id) ${deferred}`,
    "CHECK(parent_session_id IS NULL OR parent_session_id!=id)",
    "CHECK((parent_session_id IS NULL AND origin_checkpoint_id IS NULL AND created_by_run_id IS NULL) OR (parent_session_id IS NOT NULL AND origin_checkpoint_id IS NOT NULL AND created_by_run_id IS NOT NULL))",
    "CHECK((status IN ('completed','cancelled'))=(closed_at IS NOT NULL))",
    "CHECK((status IN ('completed','cancelled'))=(result IS NOT NULL OR result_json IS NOT NULL))",
  ],
  "work-checkpoint": [
    `FOREIGN KEY(session_id) REFERENCES work_sessions(id) ${deferred}`,
    `FOREIGN KEY(session_id,run_id) REFERENCES session_runs(owner_id,id) ${deferred}`,
    `FOREIGN KEY(session_id,intent_id) REFERENCES checkpoints(session_id,id) ${deferred}`,
    "UNIQUE(session_id,id)",
    "UNIQUE(session_id,sequence)",
    "CHECK(sequence BETWEEN 1 AND 9007199254740991)",
    "CHECK(session_revision BETWEEN 2 AND 9007199254740991)",
    "CHECK((checkpoint_kind='intent')=(intent_id IS NULL))",
    "CHECK(intent_id IS NULL OR intent_id!=id)",
    "CHECK(actor=created_by AND actor=updated_by)",
  ],
};

/**
 * Создаёт одну таблицу владельца с прямыми FK, скалярами и неизменяемой идентичностью.
 */
function entityTable(kind: EntityKind): string {
  const definition = ENTITY_DEFINITIONS[kind];
  const fields = [...columnsDdl(definition.columns), ...(additional[kind] ?? [])];
  const unchanged = ["id", "created_at", "created_by"]
    .map((field) => `NEW.${field} IS NOT OLD.${field}`)
    .join(" OR ");
  return `
    CREATE TABLE ${definition.table} (${metadata},${fields.join(",")}) STRICT;
    CREATE TRIGGER ${definition.table}_kind BEFORE INSERT ON ${definition.table}
    WHEN (SELECT kind FROM object_ids WHERE id=NEW.id) IS NOT '${kind}'
    BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutable}'); END;
    CREATE TRIGGER ${definition.table}_identity BEFORE UPDATE ON ${definition.table}
    WHEN ${unchanged}
    BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutable}'); END;
  `;
}

/**
 * Реляционная идентичность и локальный CAS отделены от переносимых предметных строк.
 * project_state и key_counters являются локальными техническими данными.
 */
export const ENTITY_SCHEMA =
  `
  CREATE TABLE object_ids (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
    kind TEXT NOT NULL CHECK(kind IN (${ENTITY_KINDS.map((kind) => `'${kind}'`).join(",")})),
    UNIQUE(id,kind)
  ) STRICT;
  CREATE TRIGGER object_ids_immutable BEFORE UPDATE ON object_ids
  WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind
  BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutable}'); END;
  CREATE TABLE local_entity_revisions (
    entity_id TEXT PRIMARY KEY NOT NULL REFERENCES object_ids(id) ON DELETE CASCADE ${deferred},
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)
  ) STRICT;
  CREATE TRIGGER local_entity_revisions_immutable BEFORE UPDATE ON local_entity_revisions
  WHEN NEW.entity_id IS NOT OLD.entity_id OR (NEW.revision!=OLD.revision+1 AND NOT (
    (SELECT importing FROM replication_state WHERE singleton=1)=1 AND NEW.revision=OLD.revision))
  BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutable}'); END;
  CREATE TABLE project_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    project_id TEXT NOT NULL REFERENCES projects(id) ${deferred},
    generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991)
  ) STRICT;
  CREATE TABLE key_counters (
    prefix TEXT PRIMARY KEY NOT NULL,
    value INTEGER NOT NULL CHECK(value BETWEEN 1 AND 9007199254740991)
  ) STRICT;
` +
  ENTITY_KINDS.map(entityTable).join("\n") +
  `
  CREATE UNIQUE INDEX one_project ON projects((1));
  CREATE UNIQUE INDEX one_product ON products((1));
  CREATE UNIQUE INDEX applications_slug ON applications(slug);
  CREATE UNIQUE INDEX boards_slug ON boards(slug);
  CREATE UNIQUE INDEX boards_prefix ON boards(prefix);
  CREATE UNIQUE INDEX boards_application ON boards(application_id) WHERE application_id IS NOT NULL;
  CREATE UNIQUE INDEX one_product_board ON boards((1)) WHERE application_id IS NULL;
  CREATE INDEX scenarios_feature ON scenarios(feature_id,id);
  CREATE UNIQUE INDEX implementations_feature ON implementations(application_id,feature_id) WHERE feature_id IS NOT NULL;
  CREATE UNIQUE INDEX implementations_scenario ON implementations(application_id,scenario_id) WHERE scenario_id IS NOT NULL;
  CREATE INDEX tasks_board_column ON tasks(board_id,column,id);
  CREATE INDEX tasks_parent ON tasks(parent_task_id,id);
  CREATE INDEX documents_section ON documents(project_id,section_id,pinned,id);
  CREATE INDEX work_sessions_parent ON work_sessions(parent_session_id,id);
  CREATE INDEX checkpoints_session ON checkpoints(session_id,sequence,id);
  CREATE INDEX checkpoints_intent ON checkpoints(intent_id,id);
  CREATE TRIGGER checkpoints_immutable BEFORE UPDATE ON checkpoints
  WHEN ${[
    "id",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    ...columnNames(ENTITY_DEFINITIONS["work-checkpoint"].columns),
  ]
    .map((field) => `NEW.${field} IS NOT OLD.${field}`)
    .join(" OR ")}
  BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutableHistory}'); END;
`;
