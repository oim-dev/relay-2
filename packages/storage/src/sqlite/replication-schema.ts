/**
 * Формирует JSON именно сохранённой строки, не пользовательской effective-проекции.
 */
function recordJson(row: string): string {
  return `json_object('id',${row}.id,'kind',${row}.kind,'key',${row}.key,
    'revision',${row}.revision,'createdAt',${row}.created_at,'updatedAt',${row}.updated_at,
    'createdBy',${row}.created_by,'updatedBy',${row}.updated_by,'data',json(${row}.data))`;
}

/**
 * Очередь SQL-дельт откатывается вместе с savepoint; импорт отключает захват в своей транзакции.
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
  CREATE TABLE replication_comment_order(id TEXT PRIMARY KEY REFERENCES task_comments(id), after_id TEXT) STRICT;
  CREATE TABLE replication_comment_text(
    comment_id TEXT PRIMARY KEY REFERENCES task_comments(id) ON DELETE CASCADE,
    title_json TEXT CHECK(title_json IS NULL OR (json_valid(title_json) AND json_type(title_json)='text')),
    body_json TEXT CHECK(body_json IS NULL OR (json_valid(body_json) AND json_type(body_json)='text')),
    CHECK(title_json IS NOT NULL OR body_json IS NOT NULL)
  ) STRICT;
  CREATE TABLE replication_outbox(id TEXT PRIMARY KEY, sequence INTEGER UNIQUE NOT NULL, json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_owner_heads(owner TEXT PRIMARY KEY, changeset_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_conflicts(id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_decisions(id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_resolutions(id TEXT PRIMARY KEY, changeset_id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_transition_queue(sequence INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_transition_heads(entity_id TEXT PRIMARY KEY,version TEXT NOT NULL,parents_json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_transition_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),component_sequence INTEGER NOT NULL) STRICT;
  INSERT INTO replication_transition_cursor VALUES(1,0);
  CREATE TABLE replication_remapped_refs(ref TEXT PRIMARY KEY, previous_id TEXT NOT NULL, current_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_entity_versions(entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE, version TEXT NOT NULL, parents_json TEXT NOT NULL) STRICT;
  CREATE TRIGGER replication_outbox_no_update BEFORE UPDATE ON replication_outbox BEGIN
    SELECT RAISE(ABORT, 'replication changesets are immutable');
  END;
  CREATE TRIGGER replication_resolutions_no_update BEFORE UPDATE ON replication_resolutions BEGIN
    SELECT RAISE(ABORT, 'replication resolutions are immutable');
  END;

  CREATE TRIGGER replication_entity_insert AFTER INSERT ON entities
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO replication_entity_queue VALUES(NEW.id, NULL, ${recordJson("NEW")})
    ON CONFLICT(id) DO UPDATE SET after_json=excluded.after_json;
  END;
  CREATE TRIGGER replication_entity_update AFTER UPDATE ON entities
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO replication_entity_queue VALUES(NEW.id, ${recordJson("OLD")}, ${recordJson("NEW")})
    ON CONFLICT(id) DO UPDATE SET after_json=excluded.after_json;
  END;
  CREATE TRIGGER replication_address_insert AFTER INSERT ON entity_refs
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT OR IGNORE INTO replication_address_queue VALUES(NEW.ref, NEW.entity_id);
  END;
  CREATE TRIGGER replication_comment_insert AFTER INSERT ON task_comments BEGIN
    INSERT OR IGNORE INTO replication_comment_order VALUES(NEW.id,
      (SELECT id FROM task_comments WHERE task_id=NEW.task_id AND sequence<NEW.sequence ORDER BY sequence DESC LIMIT 1));
    INSERT INTO replication_comment_queue SELECT NEW.id
      WHERE (SELECT importing FROM replication_state WHERE singleton=1)=0;
  END;
  CREATE TRIGGER replication_receipt_insert AFTER INSERT ON batch_receipts
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO replication_receipt_queue VALUES(NEW.operation_key);
  END;
`;

/**
 * Однократная очередь миграции публикует существующую v2-базу как начальный changeset.
 */
export const REPLICATION_BACKFILL = `
  INSERT INTO replication_entity_queue SELECT id, NULL, ${recordJson("entities")} FROM entities;
  INSERT INTO replication_address_queue SELECT ref,entity_id FROM entity_refs;
  INSERT INTO replication_comment_order SELECT id,lag(id) OVER(PARTITION BY task_id ORDER BY sequence) FROM task_comments;
  INSERT INTO replication_comment_queue SELECT id FROM task_comments;
  INSERT INTO replication_receipt_queue SELECT operation_key FROM batch_receipts;
`;
