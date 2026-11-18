import { relationalMessages } from "./relational.messages";

/**
 * Нормализованные неизменяемые связи истории; текст подписи является снимком, а не текущим JOIN.
 */
export const HISTORY_SCHEMA =
  `
  CREATE TABLE checkpoint_references (
    checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) DEFERRABLE INITIALLY DEFERRED,
    target_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position>=0),
    snapshot_key TEXT NOT NULL,
    snapshot_title TEXT,
    snapshot_title_json TEXT CHECK(snapshot_title_json IS NULL OR (json_valid(snapshot_title_json) AND json_type(snapshot_title_json)='text')),
    CHECK((snapshot_title IS NOT NULL)+(snapshot_title_json IS NOT NULL)=1),
    PRIMARY KEY(checkpoint_id,target_id),
    UNIQUE(checkpoint_id,position),
    FOREIGN KEY(target_id,target_kind) REFERENCES object_ids(id,kind) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE INDEX checkpoint_references_target ON checkpoint_references(target_id,checkpoint_id);
  CREATE TABLE checkpoint_acceptances (
    checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) DEFERRABLE INITIALLY DEFERRED,
    child_session_id TEXT NOT NULL REFERENCES work_sessions(id) DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK(position>=0),
    PRIMARY KEY(checkpoint_id,child_session_id),
    UNIQUE(checkpoint_id,position)
  ) STRICT;
  CREATE INDEX checkpoint_acceptances_child ON checkpoint_acceptances(child_session_id,checkpoint_id);
` +
  ["checkpoint_references", "checkpoint_acceptances"]
    .map(
      (table) => `
  CREATE TRIGGER ${table}_sealed_insert BEFORE INSERT ON ${table}
  WHEN EXISTS(SELECT 1 FROM checkpoints WHERE id=NEW.checkpoint_id)
  BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutableHistory}'); END;
  CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
  BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutableHistory}'); END;
  CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
  BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutableHistory}'); END;
`,
    )
    .join("\n");
