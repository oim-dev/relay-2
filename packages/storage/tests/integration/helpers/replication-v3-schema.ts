/**
 * Замороженная служебная форма v3 до normalized components и ordered publication tape.
 * Fixture хранит именно прежний layout, а не получает его из текущей migration implementation.
 */
export const replicationV3Schema = `
  CREATE TABLE replication_state(singleton INTEGER PRIMARY KEY,replica_id TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,base_json TEXT,observed_json TEXT,importing INTEGER NOT NULL DEFAULT 0) STRICT;
  INSERT INTO replication_state(singleton,replica_id) VALUES(1,'legacy-replica');
  CREATE TABLE replication_entity_queue(id TEXT PRIMARY KEY,before_json TEXT,after_json TEXT) STRICT;
  CREATE TABLE replication_address_queue(ref TEXT PRIMARY KEY,entity_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_comment_queue(id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE replication_receipt_queue(operation_key TEXT PRIMARY KEY) STRICT;
  CREATE TABLE replication_read_queue(owner TEXT PRIMARY KEY,entity_id TEXT NOT NULL,record_kind TEXT NOT NULL,version TEXT,changeset_id TEXT) STRICT;
  CREATE TABLE replication_comment_order(id TEXT PRIMARY KEY REFERENCES task_comments(id),after_id TEXT) STRICT;
  CREATE TABLE replication_outbox(id TEXT PRIMARY KEY,sequence INTEGER UNIQUE NOT NULL,json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_owner_heads(owner TEXT PRIMARY KEY,changeset_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_conflicts(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_decisions(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;
  CREATE TABLE replication_remapped_refs(ref TEXT PRIMARY KEY,previous_id TEXT NOT NULL,current_id TEXT NOT NULL) STRICT;
  CREATE TABLE replication_entity_versions(entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,version TEXT NOT NULL,parents_json TEXT NOT NULL) STRICT;
  CREATE TRIGGER replication_outbox_no_update BEFORE UPDATE ON replication_outbox BEGIN SELECT RAISE(ABORT,'replication changesets are immutable'); END;
  INSERT INTO replication_comment_order SELECT id,lag(id) OVER(PARTITION BY task_id ORDER BY sequence) FROM task_comments;
`;
