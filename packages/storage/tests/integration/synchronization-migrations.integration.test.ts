import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { PortableComponent, ReplicationChangeset } from "@relay/contracts";
import { ProjectDatabase } from "../../src/database/project-database";
import { portableEntity, replicationFingerprint } from "../../src/replication/portable-version";
import { batchUpgradeRecords } from "./helpers/batch-receipt-upgrade-fixture";
import { ProjectDatabaseFixture, expectRelayError } from "./helpers/project-database-fixture";

const legacySchemas = [
  { name: "v4 без таблицы расписания", version: 4 },
  { name: "v5 с ручным режимом и сохранённой задержкой обмена", version: 5 },
] as const;
const legacyReceipt = {
  operationKey: "before-v6",
  requestJson: '{ "actor": "original" }',
  resultJson: '{ "revision": 7, "key": "DOC-OLD" }',
};
const legacySchedule = {
  singleton: 1,
  mode: "manual",
  dirty_since: 123,
  last_mutation_at: 456,
  next_attempt_at: 789,
  last_attempt_at: 700,
  failures: 2,
};

/**
 * Замороженная нормализованная схема из b906f48b2e85590962939bcb95f0ee8e05698384
 * без единственного добавления v5 — synchronization_schedule. Текущие create, DDL
 * и миграторы не участвуют: после смены production layout fixture остаётся настоящей v4.
 */
const legacyV4Schema = `
  CREATE TABLE batch_receipts (
    operation_key TEXT PRIMARY KEY NOT NULL CHECK(length(operation_key)>0),
    request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
    result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object')
  ) STRICT;
  CREATE TRIGGER batch_receipts_no_update BEFORE UPDATE ON batch_receipts BEGIN
    SELECT RAISE(ABORT,'Квитанции пакетов нельзя изменять или удалять');
  END;
  CREATE TRIGGER batch_receipts_no_delete BEFORE DELETE ON batch_receipts BEGIN
    SELECT RAISE(ABORT,'Квитанции пакетов нельзя изменять или удалять');
  END;
  CREATE TABLE entities (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
    kind TEXT NOT NULL CHECK(kind IN (
      'project','product','feature','scenario','application','implementation',
      'board','task','document','work-plan','release','work-session','work-checkpoint'
    )),
    key TEXT UNIQUE NOT NULL CHECK(length(key)>0 AND instr(key,':')=0),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object')
      CHECK(kind!='task' OR json_type(data,'$.comments') IS NULL)
  ) STRICT;
  CREATE INDEX entities_kind_key ON entities(kind,key,id);
  CREATE UNIQUE INDEX one_project ON entities(kind) WHERE kind='project';
  CREATE TABLE project_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    project_id TEXT NOT NULL REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED,
    generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991)
  ) STRICT;
  CREATE TABLE key_counters (
    prefix TEXT PRIMARY KEY NOT NULL,
    value INTEGER NOT NULL CHECK(value BETWEEN 1 AND 9007199254740991)
  ) STRICT;
  CREATE TABLE task_comments (
    sequence INTEGER PRIMARY KEY,
    id TEXT UNIQUE NOT NULL CHECK(length(id)>0), task_id TEXT NOT NULL REFERENCES entities(id),
    title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
    text_encoding INTEGER NOT NULL DEFAULT 0 CHECK(text_encoding BETWEEN 0 AND 3)
  ) STRICT;
  CREATE INDEX task_comments_task_sequence ON task_comments(task_id,sequence);
  CREATE TRIGGER task_comments_kind BEFORE INSERT ON task_comments
  WHEN EXISTS(SELECT 1 FROM entities WHERE id=NEW.task_id AND kind!='task') BEGIN
    SELECT RAISE(ABORT,'comment target must be a task');
  END;
  CREATE TRIGGER task_comments_insert AFTER INSERT ON task_comments BEGIN
    UPDATE project_state SET generation=generation+1 WHERE singleton=1;
  END;
  CREATE TRIGGER entities_insert AFTER INSERT ON entities
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO entity_refs(ref,entity_id) VALUES(NEW.id,NEW.id);
    INSERT INTO entity_refs(ref,entity_id) SELECT NEW.key,NEW.id WHERE NEW.key!=NEW.id;
    UPDATE project_state SET generation=generation+1 WHERE singleton=1;
  END;
  CREATE TRIGGER entities_update AFTER UPDATE ON entities
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO entity_refs(ref,entity_id) SELECT NEW.key,NEW.id WHERE NOT EXISTS(
      SELECT 1 FROM entity_refs WHERE ref=NEW.key AND entity_id=NEW.id);
    UPDATE project_state SET generation=generation+1 WHERE singleton=1;
  END;
  CREATE TRIGGER entities_immutable BEFORE UPDATE ON entities
  WHEN NEW.id!=OLD.id OR NEW.kind!=OLD.kind OR NEW.created_at!=OLD.created_at OR NEW.created_by!=OLD.created_by
    OR (NEW.revision!=OLD.revision+1 AND NOT(
      (SELECT importing FROM replication_state WHERE singleton=1)=1 AND NEW.revision=OLD.revision))
  BEGIN SELECT RAISE(ABORT,'immutable entity fields or invalid revision'); END;
  CREATE TRIGGER task_comments_no_update BEFORE UPDATE ON task_comments
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
  BEGIN SELECT RAISE(ABORT,'task comments are append-only'); END;
  CREATE TRIGGER task_comments_no_delete BEFORE DELETE ON task_comments
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
  BEGIN SELECT RAISE(ABORT,'task comments are append-only'); END;
  CREATE TABLE replication_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    replica_id TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
    base_json TEXT, observed_json TEXT, importing INTEGER NOT NULL DEFAULT 0 CHECK(importing IN (0,1))
  ) STRICT;
  INSERT INTO replication_state(singleton,replica_id) VALUES(1,'legacy-replica');
  CREATE TABLE replication_entity_queue(id TEXT PRIMARY KEY,before_json TEXT,after_json TEXT) STRICT;
  CREATE TABLE replication_address_queue(ref TEXT PRIMARY KEY,entity_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_comment_queue(id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE replication_receipt_queue(operation_key TEXT PRIMARY KEY) STRICT;
  CREATE TABLE replication_read_queue(owner TEXT PRIMARY KEY,entity_id TEXT NOT NULL,record_kind TEXT NOT NULL,version TEXT,changeset_id TEXT) STRICT;
  CREATE TABLE replication_comment_order(id TEXT PRIMARY KEY REFERENCES task_comments(id),after_id TEXT) STRICT;
  CREATE TABLE replication_comment_text(
    comment_id TEXT PRIMARY KEY REFERENCES task_comments(id) ON DELETE CASCADE,
    title_json TEXT CHECK(title_json IS NULL OR (json_valid(title_json) AND json_type(title_json)='text')),
    body_json TEXT CHECK(body_json IS NULL OR (json_valid(body_json) AND json_type(body_json)='text')),
    CHECK(title_json IS NOT NULL OR body_json IS NOT NULL)
  ) STRICT;
  CREATE TABLE replication_outbox(id TEXT PRIMARY KEY,sequence INTEGER UNIQUE NOT NULL,json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_owner_heads(owner TEXT PRIMARY KEY,changeset_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_conflicts(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_decisions(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_resolutions(id TEXT PRIMARY KEY,changeset_id TEXT NOT NULL,json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_transition_queue(sequence INTEGER PRIMARY KEY,json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_transition_heads(entity_id TEXT PRIMARY KEY,version TEXT NOT NULL,parents_json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_transition_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),component_sequence INTEGER NOT NULL) STRICT;
  INSERT INTO replication_transition_cursor VALUES(1,0);
  CREATE TABLE replication_remapped_refs(ref TEXT PRIMARY KEY,previous_id TEXT NOT NULL,current_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_entity_versions(entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,version TEXT NOT NULL,parents_json TEXT NOT NULL) STRICT;
  CREATE TRIGGER replication_outbox_no_update BEFORE UPDATE ON replication_outbox
  BEGIN SELECT RAISE(ABORT,'replication changesets are immutable'); END;
  CREATE TRIGGER replication_resolutions_no_update BEFORE UPDATE ON replication_resolutions
  BEGIN SELECT RAISE(ABORT,'replication resolutions are immutable'); END;
  CREATE TRIGGER replication_entity_insert AFTER INSERT ON entities
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO replication_entity_queue VALUES(NEW.id,NULL,
      json_object('id',NEW.id,'kind',NEW.kind,'key',NEW.key,'revision',NEW.revision,
        'createdAt',NEW.created_at,'updatedAt',NEW.updated_at,'createdBy',NEW.created_by,
        'updatedBy',NEW.updated_by,'data',json(NEW.data)))
    ON CONFLICT(id) DO UPDATE SET after_json=excluded.after_json;
  END;
  CREATE TRIGGER replication_entity_update AFTER UPDATE ON entities
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO replication_entity_queue VALUES(NEW.id,
      json_object('id',OLD.id,'kind',OLD.kind,'key',OLD.key,'revision',OLD.revision,
        'createdAt',OLD.created_at,'updatedAt',OLD.updated_at,'createdBy',OLD.created_by,
        'updatedBy',OLD.updated_by,'data',json(OLD.data)),
      json_object('id',NEW.id,'kind',NEW.kind,'key',NEW.key,'revision',NEW.revision,
        'createdAt',NEW.created_at,'updatedAt',NEW.updated_at,'createdBy',NEW.created_by,
        'updatedBy',NEW.updated_by,'data',json(NEW.data)))
    ON CONFLICT(id) DO UPDATE SET after_json=excluded.after_json;
  END;
  CREATE TRIGGER replication_comment_insert AFTER INSERT ON task_comments BEGIN
    INSERT OR IGNORE INTO replication_comment_order VALUES(NEW.id,
      (SELECT id FROM task_comments WHERE task_id=NEW.task_id AND sequence<NEW.sequence ORDER BY sequence DESC LIMIT 1));
    INSERT INTO replication_comment_queue SELECT NEW.id WHERE (SELECT importing FROM replication_state WHERE singleton=1)=0;
  END;
  CREATE TRIGGER replication_receipt_insert AFTER INSERT ON batch_receipts
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO replication_receipt_queue VALUES(NEW.operation_key);
  END;
  CREATE TABLE entity_components (
    owner_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('collection','task-criterion','task-dependency','task-related','task-target','plan-stage','plan-task','plan-scope','plan-participant','release-plan','document-relation','session-run','document-section','section-reservation','application-participation','address-assignment')),
    id TEXT NOT NULL CHECK(length(id)>0), identity_key TEXT NOT NULL, group_id TEXT NOT NULL,
    position TEXT NOT NULL CHECK(length(position)>0), version TEXT NOT NULL,
    parents_json TEXT NOT NULL CHECK(json_valid(parents_json) AND json_type(parents_json)='array'),
    deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
    value TEXT NOT NULL CHECK(json_valid(value) AND json_type(value)='object'),
    completed_json TEXT GENERATED ALWAYS AS (CASE WHEN kind='task-criterion' THEN value -> '$.completed' END) STORED,
    target_id TEXT GENERATED ALWAYS AS (CASE WHEN kind IN ('task-dependency','task-related','plan-task') THEN json_extract(value,'$.taskId') END) STORED,
    CHECK(kind NOT IN ('task-criterion','plan-stage','session-run','document-section') OR (json_type(value,'$.id')='text' AND json_extract(value,'$.id')=id)),
    CHECK(kind!='collection' OR (json_type(value,'$.field')='text' AND json_extract(value,'$.field')=id)),
    CHECK(kind!='section-reservation' OR (json_type(value,'$.sectionId')='text' AND json_extract(value,'$.sectionId')=id)),
    PRIMARY KEY(owner_id,kind,id)
  ) STRICT;
  CREATE INDEX components_owner_kind ON entity_components(owner_id,kind,deleted,position,id);
  CREATE INDEX components_owner_version ON entity_components(owner_id,kind,id,version,position,deleted);
  CREATE INDEX components_task_graph ON entity_components(owner_id,kind,deleted,position,id,completed_json,target_id);
  CREATE UNIQUE INDEX components_active_identity ON entity_components(owner_id,kind,identity_key) WHERE deleted=0;
  CREATE UNIQUE INDEX components_address_ref ON entity_components(json_extract(value,'$.ref')) WHERE kind='address-assignment' AND deleted=0;
  CREATE INDEX components_membership_task ON entity_components(json_extract(value,'$.taskId'),owner_id) WHERE kind='plan-task' AND deleted=0;
  CREATE TABLE component_changes(owner_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,before_json TEXT,after_json TEXT,PRIMARY KEY(owner_id,kind,id)) STRICT;
  CREATE TABLE component_events(sequence INTEGER PRIMARY KEY,owner_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,before_json TEXT,after_json TEXT) STRICT;
  CREATE TABLE component_allocation_context(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT) STRICT;
  INSERT INTO component_allocation_context VALUES(1,NULL);
  CREATE TABLE component_pending_versions(owner_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,before_version TEXT,
    PRIMARY KEY(owner_id,kind,id),FOREIGN KEY(owner_id,kind,id) REFERENCES entity_components(owner_id,kind,id) ON DELETE CASCADE) STRICT;
  CREATE TRIGGER component_pending_insert AFTER INSERT ON entity_components WHEN NEW.kind='address-assignment' AND NEW.version='' BEGIN
    INSERT INTO component_pending_versions VALUES(NEW.owner_id,NEW.kind,NEW.id,NULL) ON CONFLICT(owner_id,kind,id) DO NOTHING;
  END;
  CREATE TRIGGER component_pending_remove AFTER UPDATE ON entity_components WHEN NEW.kind='address-assignment' AND NEW.deleted!=OLD.deleted BEGIN
    INSERT INTO component_pending_versions VALUES(NEW.owner_id,NEW.kind,NEW.id,OLD.version) ON CONFLICT(owner_id,kind,id) DO NOTHING;
  END;
  CREATE VIEW entity_refs AS SELECT json_extract(value,'$.ref') AS ref,owner_id AS entity_id
    FROM entity_components WHERE kind='address-assignment' AND deleted=0;
  CREATE TRIGGER component_ref_insert INSTEAD OF INSERT ON entity_refs BEGIN
    INSERT INTO entity_components(owner_id,kind,id,identity_key,group_id,position,version,parents_json,deleted,value)
    VALUES(NEW.entity_id,'address-assignment',COALESCE((SELECT 'allocated:' || json_array(id,NEW.entity_id,'address-assignment',NEW.ref) FROM component_allocation_context WHERE singleton=1 AND id IS NOT NULL),lower(hex(randomblob(16)))),NEW.ref,'','V','','[]',0,json_object('ref',NEW.ref));
    INSERT INTO replication_address_queue SELECT NEW.ref,NEW.entity_id WHERE (SELECT importing FROM replication_state WHERE singleton=1)=0;
  END;
  CREATE TRIGGER component_ref_delete INSTEAD OF DELETE ON entity_refs BEGIN
    SELECT CASE WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 THEN RAISE(ABORT,'Назначения адресов сохраняются в резерве') END;
    UPDATE entity_components SET deleted=1 WHERE owner_id=OLD.entity_id AND kind='address-assignment' AND json_extract(value,'$.ref')=OLD.ref AND deleted=0;
  END;
  CREATE TRIGGER components_no_delete BEFORE DELETE ON entity_components
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
  BEGIN SELECT RAISE(ABORT,'Снятие части требует сохраняемого tombstone'); END;
  CREATE TRIGGER components_immutable BEFORE UPDATE ON entity_components
  WHEN NEW.owner_id!=OLD.owner_id OR NEW.kind!=OLD.kind OR NEW.id!=OLD.id OR NEW.identity_key!=OLD.identity_key
    OR (OLD.deleted=1 AND NEW.deleted=0 AND OLD.kind!='collection' AND (SELECT importing FROM replication_state WHERE singleton=1)=0)
    OR (OLD.kind IN ('address-assignment','section-reservation') AND NEW.value!=OLD.value)
    OR (OLD.kind IN ('task-dependency','task-related','task-target','plan-task','plan-scope','plan-participant','release-plan','application-participation') AND NEW.value!=OLD.value)
    OR (OLD.kind='document-relation' AND json_remove(NEW.value,'$.description')!=json_remove(OLD.value,'$.description'))
    OR (OLD.kind='section-reservation' AND NEW.deleted!=OLD.deleted AND (SELECT importing FROM replication_state WHERE singleton=1)=0)
    OR (OLD.kind='session-run' AND (NEW.deleted!=OLD.deleted
      OR (json_extract(OLD.value,'$.state')!='active' AND (NEW.value!=OLD.value OR NEW.position!=OLD.position) AND (SELECT importing FROM replication_state WHERE singleton=1)=0)
      OR json_remove(OLD.value,'$.state','$.endedAt','$.endReason')!=json_remove(NEW.value,'$.state','$.endedAt','$.endReason')))
  BEGIN SELECT RAISE(ABORT,'Идентичность или история части неизменяема'); END;
  CREATE TRIGGER components_insert AFTER INSERT ON entity_components
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO component_changes VALUES(NEW.owner_id,NEW.kind,NEW.id,NULL,
      json_object('id',NEW.id,'kind',NEW.kind,'ownerId',NEW.owner_id,'position',NEW.position,'version',NEW.version,'parents',json(NEW.parents_json),'deleted',json(CASE NEW.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(NEW.value)))
    ON CONFLICT(owner_id,kind,id) DO UPDATE SET after_json=excluded.after_json;
    INSERT INTO component_events(owner_id,kind,id,before_json,after_json)
      SELECT owner_id,kind,id,NULL,after_json FROM component_changes WHERE owner_id=NEW.owner_id AND kind=NEW.kind AND id=NEW.id;
  END;
  CREATE TRIGGER components_update AFTER UPDATE ON entity_components
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO component_changes VALUES(NEW.owner_id,NEW.kind,NEW.id,
      json_object('id',OLD.id,'kind',OLD.kind,'ownerId',OLD.owner_id,'position',OLD.position,'version',OLD.version,'parents',json(OLD.parents_json),'deleted',json(CASE OLD.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(OLD.value)),
      json_object('id',NEW.id,'kind',NEW.kind,'ownerId',NEW.owner_id,'position',NEW.position,'version',NEW.version,'parents',json(NEW.parents_json),'deleted',json(CASE NEW.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(NEW.value)))
    ON CONFLICT(owner_id,kind,id) DO UPDATE SET after_json=excluded.after_json;
    INSERT INTO component_events(owner_id,kind,id,before_json,after_json) VALUES(NEW.owner_id,NEW.kind,NEW.id,
      json_object('id',OLD.id,'kind',OLD.kind,'ownerId',OLD.owner_id,'position',OLD.position,'version',OLD.version,'parents',json(OLD.parents_json),'deleted',json(CASE OLD.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(OLD.value)),
      json_object('id',NEW.id,'kind',NEW.kind,'ownerId',NEW.owner_id,'position',NEW.position,'version',NEW.version,'parents',json(NEW.parents_json),'deleted',json(CASE NEW.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(NEW.value)));
  END;
  CREATE TRIGGER task_comments_payload_immutable BEFORE UPDATE ON task_comments
  WHEN NEW.id!=OLD.id OR NEW.task_id!=OLD.task_id OR NEW.title!=OLD.title OR NEW.body!=OLD.body
    OR NEW.created_at!=OLD.created_at OR NEW.created_by!=OLD.created_by OR NEW.text_encoding!=OLD.text_encoding
  BEGIN SELECT RAISE(ABORT,'task comments are append-only'); END;
  CREATE TRIGGER replication_comment_text_insert_guard BEFORE INSERT ON replication_comment_text
  WHEN NOT EXISTS(SELECT 1 FROM task_comments c WHERE c.id=NEW.comment_id
    AND ((NEW.title_json IS NOT NULL AND (c.text_encoding & 1)!=0 AND c.title='') OR (NEW.title_json IS NULL AND (c.text_encoding & 1)=0))
    AND ((NEW.body_json IS NOT NULL AND (c.text_encoding & 2)!=0 AND c.body='') OR (NEW.body_json IS NULL AND (c.text_encoding & 2)=0)))
  BEGIN SELECT RAISE(ABORT,'Текст комментария не соответствует неизменяемой маске кодирования.'); END;
  CREATE TRIGGER replication_comment_text_no_update BEFORE UPDATE ON replication_comment_text
  BEGIN SELECT RAISE(ABORT,'task comments are append-only'); END;
  CREATE TRIGGER replication_comment_text_no_delete BEFORE DELETE ON replication_comment_text
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
  BEGIN SELECT RAISE(ABORT,'task comments are append-only'); END;
  CREATE TABLE command_read_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), replica_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)
  ) STRICT;
  INSERT INTO command_read_state SELECT 1,replica_id,0 FROM replication_state WHERE singleton=1;
  ${[
    "entities",
    "entity_components",
    "key_counters",
    "task_comments",
    "batch_receipts",
    "project_state",
    "replication_remapped_refs",
    "replication_entity_versions",
    "replication_comment_order",
    "replication_comment_text",
  ]
    .flatMap((table) =>
      ["INSERT", "UPDATE", "DELETE"].map(
        (
          event,
        ) => `CREATE TRIGGER command_read_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
          BEGIN UPDATE command_read_state SET revision=revision+1 WHERE singleton=1; END;`,
      ),
    )
    .join("\n")}
  CREATE TRIGGER command_read_replica_update AFTER UPDATE OF replica_id ON replication_state
  WHEN NEW.replica_id!=OLD.replica_id BEGIN
    UPDATE command_read_state SET replica_id=NEW.replica_id,revision=revision+1 WHERE singleton=1;
  END;
`;
const legacyV5ScheduleSchema = `
  CREATE TABLE synchronization_schedule (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    mode TEXT NOT NULL DEFAULT 'auto' CHECK(mode IN ('auto','manual')),
    dirty_since INTEGER, last_mutation_at INTEGER,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0)
  ) STRICT;
  INSERT INTO synchronization_schedule VALUES(1,'manual',123,456,789,700,2);
`;

/**
 * Создаёт закрытую файловую v4/v5 по историческому SQL, с первичными назначениями адресов,
 * квитанцией и исходным outbox с неканоническими пробелами. DELETE выбран намеренно:
 * открытие несовместимой базы не должно успеть переключить журнал в WAL.
 * Каталог и удаление файла принадлежат вызывающему fixture.
 */
function createNormalizedLegacyDatabase(path: string, version: 4 | 5): void {
  const raw = new Database(path, { create: true, strict: true });
  try {
    raw.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    raw.exec(legacyV4Schema);
    if (version === 5) {
      raw.exec(legacyV5ScheduleSchema);
    }
    raw.exec(`
      PRAGMA application_id=0x524c5932;
      PRAGMA user_version=${version};
      UPDATE replication_state SET importing=1,sequence=7,revision=7;
      INSERT INTO project_state VALUES(1,'legacy-project',83);
      INSERT INTO key_counters VALUES('DOC',17);
    `);
    const components: PortableComponent[] = [];
    for (const record of batchUpgradeRecords) {
      raw
        .query("INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          record.id,
          record.kind,
          record.key,
          record.revision,
          record.createdAt,
          record.updatedAt,
          record.createdBy,
          record.updatedBy,
          JSON.stringify(record.data),
        );
      const entity = portableEntity(record);
      raw
        .query("INSERT INTO replication_entity_versions VALUES(?,?,?)")
        .run(record.id, entity.version, "[]");
      for (const ref of [record.id, record.key]) {
        const payload = {
          ownerId: record.id,
          kind: "address-assignment" as const,
          id: `address:${ref}`,
          position: "V",
          parents: [],
          deleted: false,
          value: { ref },
        };
        const part = { ...payload, version: replicationFingerprint(payload) };
        components.push(part);
        raw
          .query(
            "INSERT INTO entity_components(owner_id,kind,id,identity_key,group_id,position,version,parents_json,deleted,value) VALUES(?,?,?,?,'','V',?,'[]',0,?)",
          )
          .run(record.id, part.kind, part.id, ref, part.version, JSON.stringify(part.value));
      }
    }
    raw
      .query("INSERT INTO batch_receipts VALUES(?,?,?)")
      .run(legacyReceipt.operationKey, legacyReceipt.requestJson, legacyReceipt.resultJson);
    const payload: Omit<ReplicationChangeset, "digest"> = {
      formatVersion: 1,
      modelVersion: 2,
      mode: "baseline",
      projectId: "legacy-project",
      id: "legacy-replica:7",
      replicaId: "legacy-replica",
      sequence: 7,
      createdAt: "2026-09-12T11:00:00.000Z",
      dependencies: [],
      readContext: [],
      entities: batchUpgradeRecords.map((record) => ({
        id: record.id,
        before: null,
        after: portableEntity(record),
      })),
      components: components.map((part) => ({
        key: JSON.stringify([part.ownerId, part.kind, part.id]),
        before: null,
        after: part,
      })),
      addresses: components.flatMap((part) =>
        part.kind === "address-assignment" ? [{ ref: part.value.ref, entityId: part.ownerId }] : [],
      ),
      comments: [],
      receipts: [legacyReceipt],
    };
    raw
      .query("INSERT INTO replication_outbox VALUES(?,?,?)")
      .run(
        payload.id,
        payload.sequence,
        JSON.stringify({ ...payload, digest: replicationFingerprint(payload) }, null, 1),
      );
    raw.exec("UPDATE replication_state SET importing=0; COMMIT");
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  } finally {
    if (raw.inTransaction) {
      raw.exec("ROLLBACK");
    }
    raw.close();
  }
}

describe("Отказ старых нормализованных схем с очередью синхронизации", () => {
  for (const method of ["open", "openReadonly"] as const) {
    test.each(legacySchemas)(
      `${method}: $name отклоняется без изменения файла, outbox и локальных метаданных`,
      ({ version }) => {
        const fixture = new ProjectDatabaseFixture("legacy-normalized", "database-redesign");
        try {
          createNormalizedLegacyDatabase(fixture.path, version);
          const before = readFileSync(fixture.path);
          const source = fixture.withRaw((raw) =>
            raw.query("SELECT * FROM replication_outbox ORDER BY sequence").all(),
          );
          expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);

          const failure = expectRelayError(() => {
            const unexpected = ProjectDatabase[method](fixture.path);
            unexpected.close();
          }, "SCHEMA_VERSION_UNSUPPORTED");

          expect(failure.details).toMatchObject({ expectedVersion: 6, actualVersion: version });
          expect(readFileSync(fixture.path)).toEqual(before);
          expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);
          fixture.withRaw((raw) => {
            expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: version });
            expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
            expect(raw.query("SELECT * FROM replication_outbox ORDER BY sequence").all()).toEqual(
              source,
            );
            expect(raw.query("SELECT * FROM project_state").get()).toEqual({
              singleton: 1,
              project_id: "legacy-project",
              generation: 83,
            });
            if (version === 5) {
              expect(raw.query("SELECT * FROM synchronization_schedule").get()).toEqual(
                legacySchedule,
              );
            } else {
              expect(
                raw
                  .query("SELECT name FROM sqlite_schema WHERE name='synchronization_schedule'")
                  .all(),
              ).toEqual([]);
            }
          });
        } finally {
          fixture.close();
        }
      },
    );
  }
});
