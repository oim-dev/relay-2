import { describe, expect, spyOn, test } from "bun:test";
import { ProjectDatabase, versionComponent } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { BatchService } from "../../src/batch/batch";
import { ReplicationService } from "../../src/replication/replication";
import { HistoryService } from "../../src/history/history";
import { TasksService } from "../../src/tasks/tasks";
import { withReplicationFixture } from "./helpers/replication-fixture";

describe("Доказательства приёма и guard локального commit", () => {
  test("решение не переписывает несовместимые первоначальные квитанции одного operationKey", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const batch = new BatchService(first);
        const local = await batch.execute(
          {
            version: 1,
            operations: [{ op: "document.create", input: { name: "Локальный", body: "Один" } }],
          },
          { actor: "left", operationKey: "same-key" },
        );
        await new BatchService(second).execute(
          {
            version: 1,
            operations: [{ op: "document.create", input: { name: "Удалённый", body: "Два" } }],
          },
          { actor: "right", operationKey: "same-key" },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const sync = new ReplicationService(first);
        const conflict = sync.prepare(published).conflicts[0];
        if (conflict === undefined) {
          throw new Error("Нет конфликта квитанций");
        }
        const queued = first.getReplicationOutbox();

        expect(() =>
          sync.resolve(
            conflict.id,
            { fingerprint: conflict.fingerprint, choice: "remote" },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_IMMUTABLE" }));

        expect(batch.getResult("same-key")).toEqual({ ...local, replayed: true });
        expect(first.getReplicationOutbox()).toEqual(queued);
        expect(first.getReplicationDecisions()).toEqual([]);
        expect(sync.conflicts()[0]?.remoteReceipts[0]?.resultJson).not.toBe(
          queued[0]?.receipts[0]?.resultJson,
        );
      },
    );
  });

  test("решение составного конфликта сохраняется после перестановки независимых массивов транспортом", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create(
          "document",
          { name: "Общий", body: "Основа" },
          "seed",
        );
        await new TasksService(db).create({ title: "Спутник" }, "seed");
      },
      async ({ first, second, remote }) => {
        const doc = new KnowledgeService(first).get("document", "DOC-1");
        const task = new TasksService(first).get("PRODUCT-1");
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "document.update",
                ref: doc.id,
                ifRevision: doc.revision,
                input: { body: "Локальный" },
              },
              {
                op: "task.update",
                ref: task.id,
                ifRevision: task.revision,
                input: { description: "Атомарный спутник" },
              },
            ],
          },
          { actor: "left", operationKey: "resolved-batch" },
        );
        const changed = new KnowledgeService(first).get("document", doc.id);
        await new KnowledgeService(first).update(
          "document",
          doc.id,
          { summary: "Зависимый" },
          { actor: "left", ifRevision: changed.revision },
        );
        await new KnowledgeService(second).update(
          "document",
          doc.id,
          { body: "Удалённый" },
          { actor: "right", ifRevision: doc.revision },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const sync = new ReplicationService(first);
        sync.accept(published);
        const conflict = sync.conflicts().find((entry) => entry.code === "REPLICATION_CONFLICT");
        if (conflict === undefined) {
          throw new Error("Нет конфликта");
        }
        const resolved = sync.resolve(
          conflict.id,
          { fingerprint: conflict.fingerprint, choice: "local" },
          "resolver",
        );
        expect(resolved.conflicts).toEqual([]);
        expect(resolved.included).toHaveLength(2);
        sync.accept(published);

        const afterTransport = sync.prepare({
          ...published,
          entities: [...published.entities].reverse(),
          addresses: [...published.addresses].reverse(),
          confirmations: [...published.confirmations].reverse(),
        });

        expect(afterTransport.conflicts).toEqual([]);
        expect(afterTransport.included).toEqual(resolved.included);
        sync.accept(afterTransport.snapshot);
        expect(sync.status().pending).toBe(0);
        expect(first.get(doc.id)?.data).toMatchObject({ body: "Локальный", summary: "Зависимый" });
        expect(first.get(task.id)?.data.description).toBe("Атомарный спутник");
      },
    );
  });

  test("структурно валидная подмена автора активного run не переписывает принятую историю", async () => {
    await withReplicationFixture(
      async (db) => {
        await new HistoryService(db).start({ title: "Владение" }, "owner");
      },
      ({ first, remote }) => {
        const session = new HistoryService(first).list({})[0];
        if (session === undefined) {
          throw new Error("Нет сессии");
        }
        const damaged = {
          ...remote,
          components: (remote.components ?? []).map((entry) =>
            entry.kind === "session-run" && entry.ownerId === session.id
              ? versionComponent({
                  ...entry,
                  value: { ...entry.value, actor: "other" },
                  parents: [entry.version],
                })
              : entry,
          ),
        };

        expect(() => new ReplicationService(first).accept(damaged)).toThrow(
          expect.objectContaining({ code: "REPLICATION_IMMUTABLE" }),
        );

        expect(new HistoryService(first).get(session.id)).toEqual(session);
      },
    );
  });

  test("чужой digest под собственным changesetId не подтверждает и не очищает очередь", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, remote }) => {
        await new KnowledgeService(first).create(
          "document",
          { name: "Несохранённая в origin", body: "Данные" },
          "author",
        );
        const sync = new ReplicationService(first);
        const prepared = sync.prepare(remote);
        const local = first.getReplicationOutbox()[0];
        if (local === undefined) {
          throw new Error("Нет changeset");
        }
        const damaged = {
          ...prepared.snapshot,
          confirmations: prepared.snapshot.confirmations.map((entry) => ({
            ...entry,
            proofs: (entry.proofs ?? []).map((proof) =>
              entry.replicaId === local.replicaId && proof.sequence === local.sequence
                ? { ...proof, digest: "0".repeat(64) }
                : proof,
            ),
          })),
        };
        const before = sync.capture();

        expect(() => sync.accept(damaged)).toThrow(
          expect.objectContaining({ code: "REPLICATION_ACK_MISMATCH" }),
        );

        expect(sync.status().pending).toBe(1);
        expect(sync.capture()).toEqual(before);
        expect(first.getReplicationOutbox()[0]?.digest).toBe(local.digest);
      },
    );
  });

  test("receipt-only гонка между чтением и commit отклоняет устаревший ack даже при прежнем generation", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create(
          "document",
          { name: "Основа", body: "Текст" },
          "seed",
        );
      },
      async ({ first, remote }) => {
        const knowledge = new KnowledgeService(first);
        const sync = new ReplicationService(first);
        const changed = await knowledge.update(
          "document",
          "DOC-1",
          { name: "Принять" },
          { actor: "writer", ifRevision: 1 },
        );
        const template = await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "document.update",
                ref: changed.id,
                ifRevision: changed.revision,
                input: { name: "Принять" },
              },
            ],
          },
          { actor: "peer", operationKey: "template-no-op" },
        );
        const published = sync.prepare(remote).snapshot;
        const generation = first.getGeneration();
        const peer = ProjectDatabase.open(first.path);
        const transaction = first.transaction.bind(first);
        let injected = false;
        // Второй настоящий SQLite writer фиксирует no-op receipt именно перед коротким commit Core.
        const boundary = spyOn(first, "transaction").mockImplementation((operation) => {
          if (!injected) {
            injected = true;
            peer.insertBatchReceipt({
              operationKey: "concurrent-no-op",
              requestJson: first.getBatchReceipt("template-no-op")?.requestJson ?? "",
              resultJson: JSON.stringify({ ...template, operationKey: "concurrent-no-op" }),
            });
          }
          return transaction(operation);
        });
        try {
          expect(() => sync.accept(published)).toThrow(
            expect.objectContaining({ code: "REPLICATION_LOCAL_CHANGED" }),
          );
          expect(first.getGeneration()).toBe(generation);
          expect(sync.status().pending).toBe(3);
          expect(first.get(changed.id)).toEqual(changed);
        } finally {
          boundary.mockRestore();
          peer.close();
        }

        const result = sync.accept(published);

        expect(result.acknowledged).toHaveLength(2);
        expect(sync.status().pending).toBe(1);
        expect(new BatchService(first).getResult("concurrent-no-op").replayed).toBe(true);
      },
    );
  });

  test("переносимая версия слияния имеет обе исходные версии и точно сохраняется после accept", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create(
          "document",
          { name: "Основа", body: "Текст" },
          "seed",
        );
      },
      async ({ first, second, remote }) => {
        const a = new KnowledgeService(first);
        const b = new KnowledgeService(second);
        await a.update("document", "DOC-1", { name: "Слева" }, { actor: "left", ifRevision: 1 });
        await b.update(
          "document",
          "DOC-1",
          { summary: "Справа" },
          { actor: "right", ifRevision: 1 },
        );
        const leftVersion = first.getReplicationOutbox()[0]?.entities[0]?.after?.version;
        const rightVersion = second.getReplicationOutbox()[0]?.entities[0]?.after?.version;
        if (leftVersion === undefined || rightVersion === undefined) {
          throw new Error("Нет версий");
        }
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const sync = new ReplicationService(first);

        const merged = sync.prepare(published).snapshot;
        const record = merged.entities.find((entry) => entry.record.key === "DOC-1");
        sync.accept(merged);

        expect(record?.parents).toEqual([leftVersion, rightVersion].sort());
        expect(sync.capture().entities.find((entry) => entry.record.key === "DOC-1")?.version).toBe(
          record?.version,
        );
        const generation = first.getGeneration();
        const transportVersion = sync.status().transportVersion;
        sync.accept(merged);
        expect(first.getGeneration()).toBe(generation);
        expect(sync.status().transportVersion).toBe(transportVersion);
      },
    );
  });
});
