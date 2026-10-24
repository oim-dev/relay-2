import type { Database } from "bun:sqlite";
import { portableEntity } from "./portable-version";
import type { ReplicationJsonRow } from "./replication.types";

/**
 * Добавляет publication/tape storage после component backfill в единственной v3→v4 транзакции.
 * Ни bytes outbox, ни исходные IDs/digests/receipts/ack не меняются и не подтверждаются.
 */
export function upgradeReplicationV4(connection: Database): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS replication_comment_text(
      comment_id TEXT PRIMARY KEY REFERENCES task_comments(id) ON DELETE CASCADE,
      title_json TEXT CHECK(title_json IS NULL OR (json_valid(title_json) AND json_type(title_json)='text')),
      body_json TEXT CHECK(body_json IS NULL OR (json_valid(body_json) AND json_type(body_json)='text')),
      CHECK(title_json IS NOT NULL OR body_json IS NOT NULL)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS replication_resolutions(id TEXT PRIMARY KEY, changeset_id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS replication_transition_queue(sequence INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS replication_transition_heads(entity_id TEXT PRIMARY KEY,version TEXT NOT NULL,parents_json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS replication_transition_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),component_sequence INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO replication_transition_cursor VALUES(1,0);
    CREATE TRIGGER IF NOT EXISTS replication_resolutions_no_update BEFORE UPDATE ON replication_resolutions BEGIN
      SELECT RAISE(ABORT, 'replication resolutions are immutable');
    END;
  `);
  const rows = connection
    .query<ReplicationJsonRow & { version: string; parents_json: string }, []>(
      `
    SELECT json_object('id',e.id,'kind',e.kind,'key',e.key,'createdAt',e.created_at,
      'updatedAt',e.updated_at,'createdBy',e.created_by,'updatedBy',e.updated_by,'data',json(e.data)) AS json,
      v.version,v.parents_json FROM entities e JOIN replication_entity_versions v ON v.entity_id=e.id
  `,
    )
    .all();
  const write = connection.query(
    "UPDATE replication_entity_versions SET version=?,parents_json=? WHERE entity_id=?",
  );
  for (const row of rows) {
    const record = JSON.parse(row.json);
    const current = portableEntity(record, JSON.parse(row.parents_json));
    if (current.version !== row.version) {
      const migrated = portableEntity(record, [row.version]);
      write.run(migrated.version, JSON.stringify(migrated.parents), migrated.record.id);
    }
  }
}
