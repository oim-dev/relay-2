/**
 * Очередь explicit typed дельт откатывается вместе с savepoint; импорт отключает захват.
 * Владельцы/части захватываются адаптерами, SQL-триггеры обслуживают независимые журнал и квитанции.
 */
export const REPLICATION_SCHEMA = `
  CREATE TABLE replication_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    replica_id TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
    base_json TEXT, observed_json TEXT, importing INTEGER NOT NULL DEFAULT 0 CHECK(importing IN (0,1))
  ) STRICT;
  INSERT INTO replication_state(singleton, replica_id) VALUES (1, lower(hex(randomblob(16))));
  CREATE TABLE replication_entity_queue(id TEXT PRIMARY KEY, before_json TEXT, after_json TEXT) STRICT;
  CREATE TABLE replication_address_queue(ref TEXT PRIMARY KEY, entity_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_comment_queue(id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE replication_receipt_queue(operation_key TEXT PRIMARY KEY) STRICT;
  CREATE TABLE replication_read_queue(owner TEXT PRIMARY KEY, entity_id TEXT NOT NULL, record_kind TEXT NOT NULL, version TEXT, changeset_id TEXT) STRICT;
  CREATE VIEW replication_comment_order AS SELECT id,after_id FROM task_comments;
  CREATE TABLE replication_outbox(id TEXT PRIMARY KEY, sequence INTEGER UNIQUE NOT NULL, json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_owner_heads(owner TEXT PRIMARY KEY, changeset_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_conflicts(id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_decisions(id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_resolutions(id TEXT PRIMARY KEY, changeset_id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
  CREATE INDEX replication_resolutions_changeset ON replication_resolutions(changeset_id);
  CREATE TABLE replication_transition_queue(sequence INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_transition_heads(entity_id TEXT PRIMARY KEY,version TEXT NOT NULL,parents_json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_transition_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),component_sequence INTEGER NOT NULL) STRICT;
  INSERT INTO replication_transition_cursor VALUES(1,0);
  CREATE TABLE replication_remapped_refs(ref TEXT PRIMARY KEY, previous_id TEXT NOT NULL, current_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_entity_versions(entity_id TEXT PRIMARY KEY REFERENCES object_ids(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, version TEXT NOT NULL, parents_json TEXT NOT NULL) STRICT;
  CREATE TRIGGER replication_outbox_no_update BEFORE UPDATE ON replication_outbox BEGIN
    SELECT RAISE(ABORT, 'replication changesets are immutable');
  END;
  CREATE TRIGGER replication_resolutions_no_update BEFORE UPDATE ON replication_resolutions BEGIN
    SELECT RAISE(ABORT, 'replication resolutions are immutable');
  END;

  CREATE TRIGGER replication_comment_insert AFTER INSERT ON task_comments
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO replication_comment_queue VALUES(NEW.id);
    DELETE FROM replication_publications;
  END;
  CREATE TRIGGER replication_receipt_insert AFTER INSERT ON batch_receipts
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO replication_receipt_queue VALUES(NEW.operation_key);
    DELETE FROM replication_publications;
  END;
`;
