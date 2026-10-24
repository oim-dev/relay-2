import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ProjectDatabase, replicationFingerprint } from "@relay/storage";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { withBoundedPublicationFixture } from "./helpers/bounded-publication-fixture";

const budget = { maxChangesets: 2, maxBytes: 1024 * 1024 };

describe("Guards ограниченного выбора публикации", () => {
  test("receipt-only writer между окном и commit отклоняет prepare, поздняя запись после prepare остаётся pending", async () => {
    await withBoundedPublicationFixture(
      async (db) => {
        await new KnowledgeService(db).create(
          "document",
          { name: "Основа", body: "Текст" },
          "seed",
        );
      },
      async ({ first, remote }) => {
        const knowledge = new KnowledgeService(first);
        const document = knowledge.get("document", "DOC-1");
        const template = await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "document.update",
                ref: document.id,
                ifRevision: document.revision,
                input: { body: "Текст" },
              },
            ],
          },
          { actor: "writer", operationKey: "template-noop" },
        );
        const receipt = first.getBatchReceipt("template-noop");
        if (receipt === undefined) {
          throw new Error("Нет исходной квитанции");
        }
        const initial = first.getReplicationGuard();
        const state = first.getReplicationState();
        const writer = new ReplicationService(first);
        const peer = ProjectDatabase.open(first.path);
        const transaction = first.transaction.bind(first);
        let injected = false;
        const boundary = spyOn(first, "transaction").mockImplementation((operation) => {
          if (!injected) {
            injected = true;
            peer.insertBatchReceipt({
              ...receipt,
              operationKey: "racing-noop",
              resultJson: JSON.stringify({ ...template, operationKey: "racing-noop" }),
            });
          }
          return transaction(operation);
        });
        try {
          expect(() => writer.prepare(remote, {}, { budget })).toThrow(
            expect.objectContaining({ code: "REPLICATION_LOCAL_CHANGED" }),
          );
        } finally {
          boundary.mockRestore();
          peer.close();
        }

        expect(first.getReplicationGuard()).toEqual({
          replicaId: initial.replicaId,
          sequence: initial.sequence + 1,
          revision: initial.revision + 1,
          generation: initial.generation,
        });
        expect(first.getReplicationState().base).toEqual(state.base);
        expect(first.getReplicationState().observed).toEqual(state.observed);
        expect(first.get(document.id)).toEqual(document);
        const sources = first.getReplicationOutbox();
        const prepared = writer.prepare(remote, {}, { budget: { ...budget, maxChangesets: 1 } });
        const late = await new KnowledgeService(first).create(
          "document",
          { name: "После подготовки", body: "Сохранить" },
          "writer",
        );
        const lateSource = first.getReplicationOutbox().at(-1);
        if (lateSource === undefined) {
          throw new Error("Нет поздней записи");
        }

        const accepted = writer.accept(prepared.snapshot);

        expect(accepted.acknowledged).toEqual(sources.slice(0, 1).map((entry) => entry.id));
        expect(first.get(late.id)).toEqual(late);
        expect(first.getReplicationOutbox()).toEqual([...sources.slice(1), lateSource]);
        expect(writer.status().pending).toBe(2);
        expect(first.getBatchReceipt("template-noop")).toEqual(receipt);
        expect(new BatchService(first).getResult("racing-noop")).toEqual({
          ...template,
          operationKey: "racing-noop",
          replayed: true,
        });
      },
    );
  });

  test("own proof вне окна сверяется с неизменным source, подмена digest не меняет observed и очередь", async () => {
    await withBoundedPublicationFixture(
      () => {},
      async ({ first, remote }) => {
        for (const name of ["Первый", "Второй", "Вне окна"]) {
          await new KnowledgeService(first).create("document", { name, body: name }, "writer");
        }
        const sources = first.getReplicationOutbox();
        const [firstSource, secondSource, outside] = sources;
        if (firstSource === undefined || secondSource === undefined || outside === undefined) {
          throw new Error("Нет source вне окна");
        }
        const writer = new ReplicationService(first);
        const published = writer.prepare(
          remote,
          {},
          { afterSequence: outside.sequence - 1, budget },
        ).snapshot;
        const guard = first.getReplicationGuard();
        const state = first.getReplicationState();
        const raw = new Database(first.path, { strict: true });
        try {
          // Корректный hash другого payload под тем же ID: проверка own proofs обязана увидеть его вне окна.
          const { digest: _digest, ...payload } = outside;
          const changed = { ...payload, createdAt: "2026-10-24T01:02:03.000Z" };
          const substituted = { ...changed, digest: replicationFingerprint(changed) };
          raw.query("DELETE FROM replication_outbox WHERE id=?").run(outside.id);
          raw
            .query("INSERT INTO replication_outbox VALUES(?,?,?)")
            .run(outside.id, outside.sequence, JSON.stringify(substituted));
          const fullRead = spyOn(first, "getReplicationOutbox").mockImplementation(() => {
            throw new Error("Неожиданное полное чтение outbox");
          });
          try {
            expect(() => writer.prepare(published, {}, { budget })).toThrow(
              expect.objectContaining({ code: "REPLICATION_ACK_MISMATCH" }),
            );
          } finally {
            fullRead.mockRestore();
          }

          expect(first.getReplicationGuard()).toEqual(guard);
          expect(first.getReplicationState()).toEqual(state);
          expect(first.getReplicationOutbox()).toEqual([firstSource, secondSource, substituted]);
          expect(writer.status().pending).toBe(3);
        } finally {
          raw.close();
        }
      },
    );
  });
});
