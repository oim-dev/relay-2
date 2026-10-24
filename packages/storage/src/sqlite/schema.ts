import { sqliteMessages } from "./sqlite.messages";
import { BATCH_RECEIPT_SCHEMA } from "./batch-schema";
import { REPLICATION_SCHEMA } from "./replication-schema";
import { PROJECT_WRITE_TRIGGERS } from "./entity-triggers";
import { COMPONENTS_SCHEMA } from "./components-schema";
import { COMMAND_SCHEMA } from "./command-schema";
import { COMMENT_TEXT_GUARDS } from "../entities/comment-text";

export const SCHEMA_VERSION = 4;
export const APPLICATION_ID = 0x524c5932;

// ID, текущие ключи и алиасы делят одно пространство ссылок: старый адрес нельзя выдать другой записи.
// Поколение изменяется вместе с сущностью, поэтому откат возвращает также версию снимка для пагинации.
export const SCHEMA =
  BATCH_RECEIPT_SCHEMA +
  `
  CREATE TABLE entities (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id) > 0),
    kind TEXT NOT NULL CHECK(kind IN (
      'project', 'product', 'feature', 'scenario', 'application', 'implementation',
      'board', 'task', 'document', 'work-plan', 'release', 'work-session', 'work-checkpoint'
    )),
    key TEXT UNIQUE NOT NULL CHECK(length(key) > 0 AND instr(key, ':') = 0),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data) = 'object')
      CHECK(kind != 'task' OR json_type(data, '$.comments') IS NULL)
  ) STRICT;
  CREATE INDEX entities_kind_key ON entities(kind, key, id);
  CREATE UNIQUE INDEX one_project ON entities(kind) WHERE kind = 'project';

  CREATE TABLE project_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    project_id TEXT NOT NULL REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED,
    generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991)
  ) STRICT;

  CREATE TABLE entity_refs (
    ref TEXT PRIMARY KEY NOT NULL,
    entity_id TEXT NOT NULL REFERENCES entities(id)
  ) STRICT;
  CREATE INDEX entity_refs_entity ON entity_refs(entity_id);

  CREATE TABLE key_counters (
    prefix TEXT PRIMARY KEY NOT NULL,
    value INTEGER NOT NULL CHECK(value BETWEEN 1 AND 9007199254740991)
  ) STRICT;

  CREATE TABLE task_comments (
    sequence INTEGER PRIMARY KEY,
    id TEXT UNIQUE NOT NULL CHECK(length(id) > 0),
    task_id TEXT NOT NULL REFERENCES entities(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    text_encoding INTEGER NOT NULL DEFAULT 0 CHECK(text_encoding BETWEEN 0 AND 3)
  ) STRICT;
  CREATE INDEX task_comments_task_sequence ON task_comments(task_id, sequence);

  CREATE TRIGGER task_comments_kind BEFORE INSERT ON task_comments
  WHEN EXISTS (SELECT 1 FROM entities WHERE id = NEW.task_id AND kind != 'task')
  BEGIN
    SELECT RAISE(ABORT, '${sqliteMessages.commentTargetConstraint}');
  END;

  CREATE TRIGGER task_comments_insert AFTER INSERT ON task_comments BEGIN
    UPDATE project_state SET generation = generation + 1 WHERE singleton = 1;
  END;

` +
  Object.values(PROJECT_WRITE_TRIGGERS).join("\n") +
  REPLICATION_SCHEMA +
  "DROP TABLE entity_refs;\n" +
  COMPONENTS_SCHEMA +
  COMMENT_TEXT_GUARDS +
  COMMAND_SCHEMA;
