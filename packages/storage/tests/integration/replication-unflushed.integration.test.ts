import { describe, expect, test } from "bun:test";
import { hasUnflushedReplicationChanges } from "../../src/replication/replication-store";
import { ProjectDatabaseFixture } from "./helpers/project-database-fixture";

const queues = [
  {
    name: "owner",
    insert: "INSERT INTO replication_entity_queue VALUES('owner',NULL,'не JSON')",
  },
  {
    name: "component без owner",
    insert: "INSERT INTO component_changes VALUES('owner','task-criterion','part',NULL,'не JSON')",
  },
  {
    name: "address",
    insert: "INSERT INTO replication_address_queue VALUES('KEY','owner')",
  },
  {
    name: "comment",
    insert: "INSERT INTO replication_comment_queue VALUES('comment')",
  },
  {
    name: "receipt",
    insert: "INSERT INTO replication_receipt_queue VALUES('receipt')",
  },
] as const;

describe("Узкий признак несброшенных изменений репликации", () => {
  test.each(queues)("$name обнаруживается без чтения payload и откатывается", ({ insert }) => {
    const fixture = new ProjectDatabaseFixture("unflushed");
    try {
      const db = fixture.create();
      // Уже сброшенная начальная мутация в durable outbox не должна блокировать обмен.
      expect(db.getReplicationOutbox()).toHaveLength(1);
      expect(db.hasUnflushedReplicationChanges()).toBe(false);
      fixture.withRaw((raw) => {
        raw.exec("BEGIN IMMEDIATE");
        try {
          // Только техническая очередь: намеренно невалидный JSON доказывает отсутствие декодирования.
          raw.exec(insert);

          expect(hasUnflushedReplicationChanges(raw)).toBe(true);
        } finally {
          raw.exec("ROLLBACK");
        }

        expect(hasUnflushedReplicationChanges(raw)).toBe(false);
      });
    } finally {
      fixture.close();
    }
  });
});
