import { relationalMessages } from "./relational.messages";

/**
 * Переносимые комментарии с явным порядком after_id; локальная нумерация хранится отдельно.
 * Carrier взаимоисключает TEXT каждого поля и не содержит generic payload записи.
 */
export const JOURNAL_SCHEMA = `
  CREATE TABLE task_comments (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
    task_id TEXT NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
    title TEXT,
    title_json TEXT CHECK(title_json IS NULL OR (json_valid(title_json) AND json_type(title_json)='text')),
    body TEXT,
    body_json TEXT CHECK(body_json IS NULL OR (json_valid(body_json) AND json_type(body_json)='text')),
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    after_id TEXT,
    CHECK((title IS NOT NULL)+(title_json IS NOT NULL)=1),
    CHECK((body IS NOT NULL)+(body_json IS NOT NULL)=1),
    CHECK(after_id IS NULL OR after_id!=id),
    UNIQUE(task_id,id),
    FOREIGN KEY(task_id,after_id) REFERENCES task_comments(task_id,id) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE INDEX task_comments_task ON task_comments(task_id,id);
  CREATE INDEX task_comments_after ON task_comments(task_id,after_id,id);
  CREATE TABLE local_comment_sequences (
    comment_id TEXT PRIMARY KEY NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    sequence INTEGER UNIQUE NOT NULL
  ) STRICT;
  CREATE TRIGGER task_comments_no_update BEFORE UPDATE ON task_comments
  WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id
    OR NEW.title IS NOT OLD.title OR NEW.title_json IS NOT OLD.title_json
    OR NEW.body IS NOT OLD.body OR NEW.body_json IS NOT OLD.body_json
    OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by
    OR (NEW.after_id IS NOT OLD.after_id AND (SELECT importing FROM replication_state WHERE singleton=1)=0)
  BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutableHistory}'); END;
  CREATE TRIGGER task_comments_no_delete BEFORE DELETE ON task_comments
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
  BEGIN SELECT RAISE(ABORT,'${relationalMessages.immutableHistory}'); END;
  CREATE TRIGGER task_comments_generation AFTER INSERT ON task_comments
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
  BEGIN UPDATE project_state SET generation=generation+1 WHERE singleton=1; END;
`;

/**
 * Переносимые технические подтверждения и последняя публикация имеют собственные physical строки.
 * Они обновляются интегратором после проверки Core, без изменения предметного поколения.
 */
export const PORTABLE_REPLICATION_SCHEMA = `
  CREATE TABLE replication_confirmations (
    replica_id TEXT PRIMARY KEY NOT NULL,
    ranges_json TEXT NOT NULL CHECK(json_valid(ranges_json) AND json_type(ranges_json)='array'),
    proofs_json TEXT CHECK(proofs_json IS NULL OR (json_valid(proofs_json) AND json_type(proofs_json)='array'))
  ) STRICT;
  CREATE TABLE replication_publications (
    id TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
    CHECK(json_type(payload_json,'$.publicationId') IS 'text' AND json_extract(payload_json,'$.publicationId')=id)
  ) STRICT;
  CREATE UNIQUE INDEX one_current_publication ON replication_publications((1));
`;
