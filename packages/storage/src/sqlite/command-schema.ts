/**
 * Все первичные источники наблюдений v4. entity_refs является проекцией entity_components,
 * поэтому её INSERT/DELETE учитываются триггерами первичной таблицы, включая импорт.
 * Временные очереди и allocation context не относятся к наблюдаемому состоянию команды.
 */
const COMMAND_READ_TABLES = [
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
];

/**
 * Подключается после основных, replication и component таблиц при создании/миграции v4.
 * Версия меняется внутри исходной транзакции, поэтому rollback возвращает также anchor.
 * Идентичность реплики копируется из replication_state и сохраняется при повторном открытии.
 */
export const COMMAND_SCHEMA = `
  CREATE TABLE command_read_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    replica_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)
  ) STRICT;
  INSERT INTO command_read_state SELECT 1,replica_id,0 FROM replication_state WHERE singleton=1;
  ${COMMAND_READ_TABLES.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (event) => `CREATE TRIGGER command_read_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN
          UPDATE command_read_state SET revision=revision+1 WHERE singleton=1;
        END;`,
    ),
  ).join("\n")}
  CREATE TRIGGER command_read_replica_update AFTER UPDATE OF replica_id ON replication_state
  WHEN NEW.replica_id != OLD.replica_id BEGIN
    UPDATE command_read_state SET replica_id=NEW.replica_id,revision=revision+1 WHERE singleton=1;
  END;
`;
