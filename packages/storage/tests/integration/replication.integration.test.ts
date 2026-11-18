import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { PortableAddress, ReplicationChangeset } from "@relay/contracts";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { ProjectDatabase } from "../../src/database/project-database";
import {
  BatchReceiptUpgradeFixture,
  batchUpgradeRecords,
} from "./helpers/batch-receipt-upgrade-fixture";
import { createDocument, expectRelayError } from "./helpers/project-database-fixture";
import { replicationV3Schema } from "./helpers/replication-v3-schema";
import { portableEntity, replicationFingerprint } from "../../src/replication/portable-version";

// Замороженное добавление v2: исторический fixture не зависит от текущей схемы квитанций.
const legacyBatchReceiptSchema = `
  CREATE TABLE batch_receipts (
    operation_key TEXT PRIMARY KEY NOT NULL CHECK(length(operation_key)>0),
    request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
    result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object')
  ) STRICT;
  CREATE TRIGGER batch_receipts_no_update BEFORE UPDATE ON batch_receipts BEGIN
    SELECT RAISE(ABORT,'Квитанции пакетов нельзя изменять или удалять');
  END;
  CREATE TRIGGER batch_receipts_no_delete BEFORE DELETE ON batch_receipts BEGIN
    SELECT RAISE(ABORT,'Квитанции пакетов нельзя изменять или удалять');
  END;
`;
// Прежние guards v3 остаются частью fixture после замены production-триггеров на typed layout.
const legacyV3WriteTriggers = `
  DROP TRIGGER entities_insert;
  DROP TRIGGER entities_update;
  DROP TRIGGER entities_immutable;
  DROP TRIGGER task_comments_no_update;
  DROP TRIGGER task_comments_no_delete;
  CREATE TRIGGER entities_insert AFTER INSERT ON entities
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO entity_refs(ref,entity_id) VALUES(NEW.id,NEW.id);
    INSERT INTO entity_refs(ref,entity_id) SELECT NEW.key,NEW.id WHERE NEW.key!=NEW.id;
    UPDATE project_state SET generation=generation+1 WHERE singleton=1;
  END;
  CREATE TRIGGER entities_update AFTER UPDATE ON entities
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
    INSERT INTO entity_refs(ref,entity_id) SELECT NEW.key,NEW.id WHERE NOT EXISTS(
      SELECT 1 FROM entity_refs WHERE ref=NEW.key AND entity_id=NEW.id);
    UPDATE project_state SET generation=generation+1 WHERE singleton=1;
  END;
  CREATE TRIGGER entities_immutable BEFORE UPDATE ON entities
  WHEN NEW.id!=OLD.id OR NEW.kind!=OLD.kind OR NEW.created_at!=OLD.created_at OR NEW.created_by!=OLD.created_by
    OR (NEW.revision!=OLD.revision+1 AND NOT(
      (SELECT importing FROM replication_state WHERE singleton=1)=1 AND NEW.revision=OLD.revision))
  BEGIN SELECT RAISE(ABORT,'immutable entity fields or invalid revision'); END;
  CREATE TRIGGER task_comments_no_update BEFORE UPDATE ON task_comments
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
  BEGIN SELECT RAISE(ABORT,'task comments are append-only'); END;
  CREATE TRIGGER task_comments_no_delete BEFORE DELETE ON task_comments
  WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
  BEGIN SELECT RAISE(ABORT,'task comments are append-only'); END;
`;

/**
 * Удерживает изолированную файловую SQLite и очищает её вместе с проверочным raw-соединением.
 */
function withReplicationDatabase(run: (db: ProjectDatabase, raw: Database) => void): void {
  const artifacts = resolve(
    import.meta.dir,
    "../../../..",
    ".artifacts",
    new Date().toLocaleDateString("sv-SE"),
    "git-sync-implementation/publication",
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "storage-"));
  const path = join(directory, "project.sqlite");
  const db = ProjectDatabase.create(path, { id: "project", name: "Реплика", slug: "replica" });
  const raw = new Database(path, { strict: true });
  try {
    run(db, raw);
  } finally {
    raw.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Durable outbox SQLite", () => {
  test("чистый snapshot не очищает пустые очереди записью и читается при чужом WAL writer", () => {
    withReplicationDatabase((db, raw) => {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const project = db.snapshot(() => db.get("PROJECT"));

        expect(project?.id).toBe(db.projectId);
        expect(raw.inTransaction).toBe(true);
      } finally {
        raw.exec("ROLLBACK");
      }
    });
  });

  test("отказ v3 сохраняет исходные байты changeset, digest, ID и историческую квитанцию без подтверждения", () => {
    const fixture = new BatchReceiptUpgradeFixture();
    try {
      fixture.createV1();
      const source = fixture.withRaw((raw) => {
        raw.exec(legacyBatchReceiptSchema);
        raw.exec(replicationV3Schema);
        raw.exec(legacyV3WriteTriggers);
        const entities = batchUpgradeRecords.map((record) => ({
          ...portableEntity(record),
          record,
        }));
        for (const entry of entities) {
          raw
            .query("INSERT INTO replication_entity_versions VALUES(?,?,?)")
            .run(entry.record.id, entry.version, "[]");
        }
        const receipt = {
          operationKey: "historical",
          requestJson: '{"actor":"old"}',
          resultJson: '{"revision":77,"key":"DOC-OLD"}',
        };
        raw
          .query("INSERT INTO batch_receipts VALUES(?,?,?)")
          .run(receipt.operationKey, receipt.requestJson, receipt.resultJson);
        const payload: Omit<ReplicationChangeset, "digest"> = {
          formatVersion: 1,
          mode: "baseline",
          projectId: "legacy-project",
          id: "legacy-replica:7",
          replicaId: "legacy-replica",
          sequence: 7,
          createdAt: "2026-09-12T11:00:00.000Z",
          dependencies: [],
          readContext: [],
          entities: entities.map((entry) => ({ id: entry.record.id, before: null, after: entry })),
          addresses: raw
            .query<PortableAddress, []>(
              "SELECT ref,entity_id AS entityId FROM entity_refs ORDER BY ref",
            )
            .all(),
          comments: [],
          receipts: [receipt],
        };
        const change = { ...payload, digest: replicationFingerprint(payload) };
        const json = JSON.stringify(change, null, 1);
        raw
          .query("INSERT INTO replication_outbox VALUES(?,?,?)")
          .run(change.id, change.sequence, json);
        raw.exec(
          "UPDATE replication_state SET sequence=7; PRAGMA user_version=3; PRAGMA journal_mode=DELETE",
        );
        expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
        return {
          json,
          change,
          receipt,
          project: raw.query("SELECT * FROM project_state").get(),
          replication: raw.query("SELECT * FROM replication_state").get(),
        };
      });
      const before = readFileSync(fixture.path);

      const failure = expectRelayError(() => fixture.open(), "SCHEMA_VERSION_UNSUPPORTED");

      expect(failure.details).toMatchObject({ expectedVersion: 6, actualVersion: 3 });
      expect(readFileSync(fixture.path)).toEqual(before);
      expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);
      fixture.withRaw((raw) => {
        expect(raw.query("SELECT * FROM replication_outbox").all()).toEqual([
          { id: source.change.id, sequence: source.change.sequence, json: source.json },
        ]);
        expect(raw.query("SELECT * FROM project_state").get()).toEqual(source.project);
        expect(raw.query("SELECT * FROM replication_state").get()).toEqual(source.replication);
        expect(raw.query("SELECT * FROM batch_receipts").all()).toEqual([
          {
            operation_key: source.receipt.operationKey,
            request_json: source.receipt.requestJson,
            result_json: source.receipt.resultJson,
          },
        ]);
        expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
        expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      });
    } finally {
      fixture.close();
    }
  });

  test("outer transaction схлопывает записи, а перехваченный savepoint откатывает очередь и зависимости", () => {
    withReplicationDatabase((db) => {
      const document = createDocument();
      const pending = db.getReplicationOutbox().length;

      db.transaction(() => {
        db.insert(document);
        try {
          db.transaction(() => {
            db.rename(document.id, "TEMP-1", 1, "rolled-back");
            db.insert(createDocument("ROLLED-1"));
            throw new Error("rollback savepoint");
          });
        } catch {
          /* Намеренный отказ вложенного сценария перехвачен внешней транзакцией. */
        }
        db.update({ ...document, revision: 2, data: { ...document.data, name: "Итог" } }, 1);
      });

      const outbox = db.getReplicationOutbox();
      const change = outbox.at(-1);
      expect(outbox).toHaveLength(pending + 1);
      expect(change?.entities).toHaveLength(1);
      expect(change?.entities[0]?.before).toBeNull();
      expect(change?.entities[0]?.after?.record).toMatchObject({
        id: document.id,
        key: document.key,
        data: { name: "Итог" },
      });
      expect(change?.entities[0]?.after?.record).not.toHaveProperty("revision");
      expect(db.get(document.id)?.revision).toBe(2);
      expect(
        change?.addresses.some((entry) => entry.ref === "TEMP-1" || entry.ref === "ROLLED-1"),
      ).toBe(false);
      expect(change?.dependencies).toEqual([]);
      expect(db.get("TEMP-1")).toBeUndefined();
      const reopened = ProjectDatabase.open(db.path);
      try {
        expect(reopened.getReplicationOutbox()).toEqual(outbox);
      } finally {
        reopened.close();
      }
    });
  });

  test("отказ durable insert откатывает данные, адреса, generation и sequence целиком", () => {
    withReplicationDatabase((db, raw) => {
      const generation = db.getGeneration();
      const queue = db.getReplicationOutbox();
      const state = db.getReplicationState();
      raw.exec(
        "CREATE TRIGGER fail_outbox BEFORE INSERT ON replication_outbox BEGIN SELECT RAISE(ABORT, 'fixture: durable failure'); END",
      );
      const document = createDocument();

      expect(() => db.insert(document)).toThrow(
        expect.objectContaining({
          code: "CONFLICT",
          details: expect.objectContaining({ reason: "fixture: durable failure" }),
        }),
      );

      expect(db.get(document.id)).toBeUndefined();
      expect(db.get(document.key)).toBeUndefined();
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(queue);
      expect(db.getReplicationState()).toEqual(state);
      expect(raw.query("SELECT * FROM replication_entity_queue").all()).toEqual([]);
    });
  });

  test("receipt-only transaction попадает в очередь без изменения generation", () => {
    withReplicationDatabase((db) => {
      const generation = db.getGeneration();
      const count = db.getReplicationOutbox().length;
      const receipt = { operationKey: "no-op", requestJson: "{}", resultJson: "{}" };

      db.insertBatchReceipt(receipt);

      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toHaveLength(count + 1);
      expect(db.getReplicationOutbox().at(-1)).toMatchObject({
        entities: [],
        comments: [],
        receipts: [receipt],
      });
    });
  });

  test("текущая схема запрещает перезапись outbox и сохраняет точный источник после повторного открытия", () => {
    withReplicationDatabase((db, raw) => {
      const document = createDocument();
      const receipt = {
        operationKey: "immutable-source",
        requestJson: '{ "actor": "original" }',
        resultJson: '{ "revision": 17, "key": "DOC-OLD" }',
      };
      db.transaction(() => {
        db.insert(document);
        db.insertBatchReceipt(receipt);
      });
      const queue = db.getReplicationOutbox();
      const sources = raw.query("SELECT * FROM replication_outbox ORDER BY sequence").all();
      const generation = db.getGeneration();
      const state = db.getReplicationState();

      expect(() => raw.exec("UPDATE replication_outbox SET json='{}'")).toThrow(
        expect.objectContaining({ code: "SQLITE_CONSTRAINT_TRIGGER" }),
      );

      expect(raw.query("SELECT * FROM replication_outbox ORDER BY sequence").all()).toEqual(
        sources,
      );
      const reopened = ProjectDatabase.open(db.path);
      try {
        expect(reopened.getReplicationOutbox()).toEqual(queue);
        expect(reopened.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
        expect(reopened.get(document.id)).toEqual(document);
        expect(reopened.getGeneration()).toBe(generation);
        expect(reopened.getReplicationState()).toEqual(state);
      } finally {
        reopened.close();
      }
    });
  });
});
