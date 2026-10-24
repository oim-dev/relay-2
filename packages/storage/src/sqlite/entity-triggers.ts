import { sqliteMessages } from "./sqlite.messages";

/**
 * Общий источник SQL-защит для создания v3 и обновления v1/v2.
 * Импорт разрешает техническую перестановку адресов/журнала, но не меняет ID, вид и авторство создания.
 */
export const PROJECT_WRITE_TRIGGERS = {
  entities_insert: `CREATE TRIGGER entities_insert AFTER INSERT ON entities
    WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
      INSERT INTO entity_refs(ref, entity_id) VALUES (NEW.id, NEW.id);
      INSERT INTO entity_refs(ref, entity_id) SELECT NEW.key, NEW.id WHERE NEW.key != NEW.id;
      UPDATE project_state SET generation=generation+1 WHERE singleton=1;
    END;`,
  entities_update: `CREATE TRIGGER entities_update AFTER UPDATE ON entities
    WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
      INSERT INTO entity_refs(ref, entity_id) SELECT NEW.key, NEW.id WHERE NOT EXISTS (
        SELECT 1 FROM entity_refs WHERE ref=NEW.key AND entity_id=NEW.id
      );
      UPDATE project_state SET generation=generation+1 WHERE singleton=1;
    END;`,
  entities_immutable: `CREATE TRIGGER entities_immutable BEFORE UPDATE ON entities
    WHEN NEW.id != OLD.id OR NEW.kind != OLD.kind
      OR NEW.created_at != OLD.created_at OR NEW.created_by != OLD.created_by
      OR (NEW.revision != OLD.revision+1 AND NOT (
        (SELECT importing FROM replication_state WHERE singleton=1)=1 AND NEW.revision=OLD.revision))
    BEGIN SELECT RAISE(ABORT, '${sqliteMessages.immutableEntityConstraint}'); END;`,
  task_comments_no_update: `CREATE TRIGGER task_comments_no_update BEFORE UPDATE ON task_comments
    WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
    BEGIN SELECT RAISE(ABORT, '${sqliteMessages.appendOnlyConstraint}'); END;`,
  task_comments_no_delete: `CREATE TRIGGER task_comments_no_delete BEFORE DELETE ON task_comments
    WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
    BEGIN SELECT RAISE(ABORT, '${sqliteMessages.appendOnlyConstraint}'); END;`,
} as const;
