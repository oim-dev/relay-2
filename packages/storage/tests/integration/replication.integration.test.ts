import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { PortableAddress, ReplicationChangeset } from "@relay/contracts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { ProjectDatabase } from "../../src/database/project-database";
import { BATCH_RECEIPT_SCHEMA } from "../../src/sqlite/batch-schema";
import {
  BatchReceiptUpgradeFixture,
  batchUpgradeRecords,
} from "./helpers/batch-receipt-upgrade-fixture";
import { createDocument } from "./helpers/project-database-fixture";
import { replicationV3Schema } from "./helpers/replication-v3-schema";
import { PROJECT_WRITE_TRIGGERS } from "../../src/sqlite/entity-triggers";
import { portableEntity, replicationFingerprint } from "../../src/replication/portable-version";

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

  test("upgrade v3 сохраняет bytes старого source с revision, digest, ID и historical receipt без фиктивного ack", () => {
    const fixture = new BatchReceiptUpgradeFixture();
    try {
      fixture.createV1();
      const source = fixture.withRaw((raw) => {
        raw.exec(BATCH_RECEIPT_SCHEMA);
        raw.exec(replicationV3Schema);
        for (const [name, sql] of Object.entries(PROJECT_WRITE_TRIGGERS)) {
          raw.exec(`DROP TRIGGER ${name}`);
          raw.exec(sql);
        }
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
        raw.exec("UPDATE replication_state SET sequence=7; PRAGMA user_version=3");
        return {
          json,
          change,
          generation: raw
            .query<{ generation: number }, []>("SELECT generation FROM project_state")
            .get()?.generation,
        };
      });

      const db = fixture.open();

      expect(db.getReplicationOutbox()).toEqual([source.change]);
      expect(
        fixture.withRaw(
          (raw) =>
            raw.query<{ json: string }, []>("SELECT json FROM replication_outbox").get()?.json,
        ),
      ).toBe(source.json);
      expect(db.getReplicationState()).toMatchObject({
        replicaId: "legacy-replica",
        sequence: 7,
        base: null,
      });
      expect(
        db.captureReplication().entities.every((entry) => !Object.hasOwn(entry.record, "revision")),
      ).toBe(true);
      expect(db.get("legacy-document")?.revision).toBe(4);
      expect(db.getGeneration()).toBe(source.generation ?? -1);
      expect(db.getBatchReceipt("historical")?.resultJson).toBe('{"revision":77,"key":"DOC-OLD"}');
      expect(db.captureReplication().confirmations).toEqual([]);
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
        db.update({ ...document, revision: 2, data: { title: "Итог" } }, 1);
      });

      const outbox = db.getReplicationOutbox();
      const change = outbox.at(-1);
      expect(outbox).toHaveLength(pending + 1);
      expect(change?.entities).toHaveLength(1);
      expect(change?.entities[0]?.before).toBeNull();
      expect(change?.entities[0]?.after?.record).toMatchObject({
        id: document.id,
        key: document.key,
        data: { title: "Итог" },
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

  test("обновление v2 сохраняет существующие квитанции, алиасы, журнал и поколение", () => {
    const fixture = new BatchReceiptUpgradeFixture();
    try {
      fixture.createV1();
      fixture.withRaw((raw) => {
        raw.exec(BATCH_RECEIPT_SCHEMA);
        raw.exec("PRAGMA user_version=2");
        raw.exec(
          "INSERT INTO batch_receipts VALUES('historical','{\"request\":1}','{\"result\":2}')",
        );
      });
      const before = fixture.withRaw((raw) => ({
        records: raw.query("SELECT * FROM entities ORDER BY id").all(),
        addresses: raw.query("SELECT * FROM entity_refs ORDER BY ref").all(),
        comments: raw
          .query(
            "SELECT sequence,id,task_id,title,body,created_at,created_by FROM task_comments ORDER BY sequence",
          )
          .all(),
        state: raw.query("SELECT * FROM project_state").get(),
      }));

      const upgraded = fixture.open();

      expect(upgraded.getBatchReceipt("historical")).toEqual({
        operationKey: "historical",
        requestJson: '{"request":1}',
        resultJson: '{"result":2}',
      });
      expect(upgraded.getReplicationOutbox()).toHaveLength(1);
      expect(upgraded.getReplicationOutbox()[0]?.mode).toBe("baseline");
      expect(upgraded.getReplicationOutbox()[0]?.comments).toHaveLength(2);
      expect(
        fixture.withRaw((raw) => ({
          records: raw.query("SELECT * FROM entities ORDER BY id").all(),
          addresses: raw.query("SELECT * FROM entity_refs ORDER BY ref").all(),
          comments: raw
            .query(
              "SELECT sequence,id,task_id,title,body,created_at,created_by FROM task_comments ORDER BY sequence",
            )
            .all(),
          state: raw.query("SELECT * FROM project_state").get(),
        })),
      ).toEqual(before);
      expect(
        fixture.withRaw((raw) =>
          raw.query("SELECT id,text_encoding FROM task_comments ORDER BY sequence").all(),
        ),
      ).toEqual([
        { id: "legacy-comment-first", text_encoding: 0 },
        { id: "legacy-comment-second", text_encoding: 0 },
      ]);
      expect(
        fixture.withRaw((raw) =>
          raw.query("SELECT comment_id FROM replication_comment_text").all(),
        ),
      ).toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
