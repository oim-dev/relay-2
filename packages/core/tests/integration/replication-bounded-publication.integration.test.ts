import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ProjectDatabase, replicationFingerprint } from "@relay/storage";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { decodeReplicationSnapshot } from "../../src/replication/snapshot-decoder";
import { publishChanges } from "../../src/replication/publication";
import { withBoundedPublicationFixture } from "./helpers/bounded-publication-fixture";

const budget = { maxChangesets: 2, maxBytes: 1024 * 1024 };

describe("Ограниченные публикации исходных changeset", () => {
  test("три окна сохраняют atomic receipts, причинный порядок, local overlay и точные proofs без echo", async () => {
    await withBoundedPublicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const batch = new BatchService(first);
        const knowledge = new KnowledgeService(first);
        await batch.execute(
          {
            version: 1,
            operations: [
              { op: "document.create", input: { name: "Первый", body: "Исходный" } },
              { op: "document.create", input: { name: "Спутник", body: "Атомарный" } },
            ],
          },
          { actor: "writer", operationKey: "atomic-pair" },
        );
        const before = knowledge.get("document", "DOC-1");
        await knowledge.update(
          "document",
          before.id,
          { body: "Зависимое продолжение" },
          { actor: "writer", ifRevision: before.revision },
        );
        const independent = await knowledge.create(
          "document",
          { name: "Независимый", body: "Третья транзакция" },
          "writer",
        );
        await batch.execute(
          {
            version: 1,
            operations: [
              {
                op: "document.update",
                ref: independent.id,
                ifRevision: independent.revision,
                input: { body: "Третья транзакция" },
              },
            ],
          },
          { actor: "writer", operationKey: "receipt-only" },
        );
        const last = await knowledge.create(
          "document",
          { name: "Последний", body: "Пятая транзакция" },
          "writer",
        );
        const sources = first.getReplicationOutbox();
        const [pair, update, create, receipt, tail] = sources;
        if (!pair || !update || !create || !receipt || !tail) {
          throw new Error("Нет пяти исходных changeset");
        }
        expect(sources).toHaveLength(5);
        expect(update.dependencies).toContain(pair.id);
        expect(receipt.entities).toEqual([]);
        expect(receipt.dependencies).toContain(create.id);
        const writer = new ReplicationService(first);
        const reader = new ReplicationService(second);
        const local = writer.capture();
        let head = remote;
        let cursor = 0;
        const windows = [
          { included: [pair, update], pending: [create, receipt, tail], more: true },
          { included: [create, receipt], pending: [tail], more: true },
          { included: [tail], pending: [], more: false },
        ];

        for (const window of windows) {
          const prepared = writer.prepare(head, {}, { afterSequence: cursor, budget });
          const publication = prepared.snapshot.publication;
          if (publication == null) {
            throw new Error("Нет bounded publication");
          }
          expect(prepared.included).toEqual(window.included.map((source) => source.id));
          expect(prepared.selection.examined).toEqual(prepared.included);
          expect(prepared.selection.deferred).toEqual([]);
          expect(prepared.selection.pending).toBe(window.pending.length + window.included.length);
          expect(prepared.selection.hasMore).toBe(window.more);
          expect(prepared.conflicts).toEqual([]);
          expect(prepared.snapshot.publication?.changes.map((entry) => entry.source)).toEqual(
            window.included,
          );
          expect(prepared.snapshot.publication?.parent?.publicationId).toBe(
            head.publication?.publicationId,
          );

          const accepted = writer.accept(prepared.snapshot);
          reader.accept(prepared.snapshot);

          expect(accepted.acknowledged).toEqual(prepared.included);
          expect(accepted.reconciled).toBe(true);
          expect(first.getReplicationOutbox()).toEqual(window.pending);
          expect(writer.status().pending).toBe(window.pending.length);
          expect(reader.status().pending).toBe(0);
          expect(writer.capture().entities).toEqual(local.entities);
          expect(writer.capture().receipts).toEqual(local.receipts);
          for (const source of window.included) {
            const proof = prepared.snapshot.confirmations
              .find((entry) => entry.replicaId === source.replicaId)
              ?.proofs?.find((entry) => entry.sequence === source.sequence);
            const change = prepared.snapshot.publication?.changes.find(
              (entry) => entry.source.id === source.id,
            );
            expect(proof).toEqual({
              sequence: source.sequence,
              digest: source.digest,
              publicationId: publication.publicationId,
              resolutionId: null,
              outcome: "applied",
              effectDigest: replicationFingerprint(change?.transitions),
            });
          }
          cursor = prepared.selection.nextSequence;
          head = prepared.snapshot;
        }

        expect(cursor).toBe(0);
        expect(second.get(before.id)?.data.body).toBe("Зависимое продолжение");
        expect(second.get(last.id)?.data.body).toBe("Пятая транзакция");
        expect(second.getBatchReceipt("atomic-pair")).toEqual(first.getBatchReceipt("atomic-pair"));
        expect(second.getBatchReceipt("receipt-only")).toEqual(
          first.getBatchReceipt("receipt-only"),
        );
        const guard = first.getReplicationGuard();
        expect(writer.accept(head).acknowledged).toEqual([]);
        expect(first.getReplicationGuard()).toEqual(guard);
      },
    );
  });

  test("cursor после reopen проводит независимые пакеты за конфликтным и blocked префиксом с holes", async () => {
    await withBoundedPublicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("document", { name: "Общий", body: "До" }, "seed");
      },
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const original = knowledge.get("document", "DOC-1");
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "document.update",
                ref: original.id,
                ifRevision: original.revision,
                input: { body: "Локальный конфликт" },
              },
              {
                op: "document.create",
                input: { name: "Спутник", body: "Не публиковать частично" },
              },
            ],
          },
          { actor: "left", operationKey: "conflicting-pair" },
        );
        const companion = knowledge.get("document", "DOC-2");
        const changed = knowledge.get("document", original.id);
        await knowledge.update(
          "document",
          original.id,
          { summary: "Зависимая локальная правка" },
          { actor: "left", ifRevision: changed.revision },
        );
        const dependent = await knowledge.create(
          "document",
          { name: "Зависимый", body: "Ссылка на непринятую цель", targets: [companion.id] },
          "left",
        );
        const independent = await knowledge.create(
          "document",
          { name: "Независимый", body: "Доставка разрешена" },
          "left",
        );
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              { op: "document.create", input: { name: "Пятый", body: "Последнее окно" } },
              { op: "document.create", input: { name: "Шестой", body: "Тот же атомарный пакет" } },
            ],
          },
          { actor: "left", operationKey: "independent-pair" },
        );
        const [conflicting, blocked, referenced, ready, pair] = first.getReplicationOutbox();
        if (!conflicting || !blocked || !referenced || !ready || !pair) {
          throw new Error("Нет причинной цепочки");
        }
        expect(blocked.dependencies).toContain(conflicting.id);
        expect(referenced.dependencies).toContain(conflicting.id);
        await new KnowledgeService(second).update(
          "document",
          original.id,
          { body: "Удалённый конфликт" },
          { actor: "right", ifRevision: original.revision },
        );
        const reader = new ReplicationService(second);
        const incoming = reader.prepare(remote).snapshot;
        reader.accept(incoming);
        const firstWindow = new ReplicationService(first).prepare(incoming, {}, { budget });

        expect(firstWindow.included).toEqual([]);
        expect(firstWindow.conflicts.map((entry) => entry.id)).toEqual([conflicting.id]);
        expect(firstWindow.selection.deferred).toEqual([blocked.id]);
        expect(firstWindow.selection.waiting).toEqual([
          {
            id: blocked.id,
            state: "pending",
            code: "REPLICATION_DEPENDENCY",
            message: "Изменение ожидает принятия причинной зависимости",
            dependencies: [conflicting.id],
          },
        ]);
        expect(firstWindow.selection).toMatchObject({
          nextSequence: blocked.sequence,
          hasMore: true,
          pending: 5,
        });

        const reopened = ProjectDatabase.open(first.path);
        try {
          const writer = new ReplicationService(reopened);
          const secondWindow = writer.prepare(
            incoming,
            {},
            {
              afterSequence: firstWindow.selection.nextSequence,
              budget,
            },
          );
          expect(secondWindow.included).toEqual([ready.id]);
          expect(secondWindow.selection.examined).toEqual([referenced.id, ready.id]);
          expect(secondWindow.selection.deferred).toEqual([referenced.id]);
          expect(secondWindow.conflicts).toEqual([]);
          expect(writer.conflicts().map((entry) => entry.id)).toEqual([conflicting.id]);
          expect(
            secondWindow.snapshot.receipts.some(
              (entry) => entry.operationKey === "conflicting-pair",
            ),
          ).toBe(false);
          expect(
            secondWindow.snapshot.entities.some((entry) => entry.record.id === companion.id),
          ).toBe(false);
          writer.accept(secondWindow.snapshot);
          reader.accept(secondWindow.snapshot);

          const lastWindow = writer.prepare(
            secondWindow.snapshot,
            {},
            {
              afterSequence: secondWindow.selection.nextSequence,
              budget,
            },
          );
          expect(lastWindow.included).toEqual([pair.id]);
          expect(lastWindow.selection).toMatchObject({
            nextSequence: 0,
            hasMore: false,
            pending: 4,
          });
          writer.accept(lastWindow.snapshot);
          reader.accept(lastWindow.snapshot);

          expect(writer.status()).toMatchObject({ pending: 3, conflicts: 1 });
          expect(
            writer
              .blocked()
              .map(({ id, dependencies, state, code }) => ({ id, dependencies, state, code })),
          ).toEqual([
            {
              id: blocked.id,
              dependencies: [conflicting.id],
              state: "pending",
              code: "REPLICATION_DEPENDENCY",
            },
            {
              id: referenced.id,
              dependencies: [conflicting.id],
              state: "pending",
              code: "REPLICATION_DEPENDENCY",
            },
          ]);
          expect(reopened.getReplicationOutbox()).toEqual([conflicting, blocked, referenced]);
          expect(reopened.get(original.id)?.data).toMatchObject({
            body: "Локальный конфликт",
            summary: "Зависимая локальная правка",
          });
          expect(
            new KnowledgeService(reopened)
              .get("document", dependent.id)
              .data.relations.map((entry) => entry.target.id),
          ).toEqual([companion.id]);
          expect(reopened.getBatchReceipt("conflicting-pair")).toEqual(conflicting.receipts[0]);
          expect(second.get(original.id)?.data.body).toBe("Удалённый конфликт");
          expect(second.get(companion.id)).toBeUndefined();
          expect(second.get(dependent.id)).toBeUndefined();
          expect(second.get(independent.id)?.data.body).toBe("Доставка разрешена");
          expect(second.getBatchReceipt("conflicting-pair")).toBeUndefined();
          expect(second.getBatchReceipt("independent-pair")).toEqual(pair.receipts[0]);
          const confirmation = lastWindow.snapshot.confirmations.find(
            (entry) => entry.replicaId === ready.replicaId,
          );
          expect(confirmation?.ranges).toEqual([
            [1, conflicting.sequence - 1],
            [ready.sequence, pair.sequence],
          ]);
          expect(confirmation?.proofs?.map((entry) => entry.sequence)).toEqual([
            1,
            2,
            ready.sequence,
            pair.sequence,
          ]);
          expect(
            confirmation?.proofs
              ?.filter((entry) => entry.sequence >= ready.sequence)
              .map((entry) => entry.digest),
          ).toEqual([ready.digest, pair.digest]);
          expect(reader.status().pending).toBe(0);
        } finally {
          reopened.close();
        }
      },
    );
  });

  test("byte budget выбирается до decode, oversized atomic source идёт один, хвост не читается", async () => {
    await withBoundedPublicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "document.create",
                input: { name: "Атомарный А", body: "Большой текст\ud800" },
              },
              { op: "document.create", input: { name: "Атомарный Б", body: "Вторая часть" } },
            ],
          },
          { actor: "writer", operationKey: "oversized" },
        );
        await new KnowledgeService(first).create(
          "document",
          { name: "Хвост", body: "Позже" },
          "writer",
        );
        const [atomic, tail] = first.getReplicationOutbox();
        if (!atomic || !tail) {
          throw new Error("Нет двух источников");
        }
        const atomicBytes = new TextEncoder().encode(JSON.stringify(atomic)).byteLength;
        const tailBytes = new TextEncoder().encode(JSON.stringify(tail)).byteLength;
        const fitsOnlyFirst = first.getReplicationOutboxWindow({
          afterSequence: 0,
          maxChangesets: 3,
          maxBytes: atomicBytes + tailBytes - 1,
        });
        expect(fitsOnlyFirst.changesets).toEqual([atomic]);
        expect(fitsOnlyFirst).toMatchObject({
          sourceBytes: atomicBytes,
          oversized: false,
          hasMore: true,
        });
        const raw = new Database(first.path, { strict: true });
        const sync = new ReplicationService(first);
        try {
          // Повреждённый payload за byte budget обнаружится только при явном чтении следующего окна.
          raw.query("DELETE FROM replication_outbox WHERE id=?").run(tail.id);
          raw
            .query("INSERT INTO replication_outbox VALUES(?,?,?)")
            .run(tail.id, tail.sequence, "{");
          const fullRead = spyOn(first, "getReplicationOutbox").mockImplementation(() => {
            throw new Error("prepare прочитал полный outbox вместо окна");
          });
          try {
            const prepared = sync.prepare(
              remote,
              {},
              { budget: { maxChangesets: 3, maxBytes: 1 } },
            );
            expect(prepared.included).toEqual([atomic.id]);
            expect(prepared.selection).toMatchObject({
              oversized: true,
              hasMore: true,
              pending: 2,
              examined: [atomic.id],
              sourceBytes: new TextEncoder().encode(JSON.stringify(atomic)).byteLength,
            });
            expect(prepared.snapshot.publication?.changes[0]?.source).toEqual(atomic);
            new ReplicationService(second).accept(prepared.snapshot);
            expect(second.get("DOC-1")?.data.body).toBe("Большой текст\ud800");
            expect(second.get("DOC-2")?.data.body).toBe("Вторая часть");
            expect(second.get("DOC-3")).toBeUndefined();
            expect(second.getBatchReceipt("oversized")).toEqual(atomic.receipts[0]);
            expect(sync.status().pending).toBe(2);
            expect(() =>
              sync.prepare(
                prepared.snapshot,
                {},
                {
                  afterSequence: prepared.selection.nextSequence,
                  budget,
                },
              ),
            ).toThrow(SyntaxError);
          } finally {
            fullRead.mockRestore();
          }
        } finally {
          raw.close();
        }
      },
    );
  });

  test("consumer отвергает переставленные зависимые sources при самосогласованном envelope", async () => {
    await withBoundedPublicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const document = await knowledge.create(
          "document",
          { name: "До", body: "Текст" },
          "writer",
        );
        await knowledge.update(
          "document",
          document.id,
          { name: "После" },
          {
            actor: "writer",
            ifRevision: document.revision,
          },
        );
        const prepared = new ReplicationService(first).prepare(remote, {}, { budget });
        const changes = prepared.snapshot.publication?.changes;
        if (changes === undefined) {
          throw new Error("Нет публикации");
        }
        const forged = publishChanges(remote, prepared.snapshot, [...changes].reverse());
        expect(() => decodeReplicationSnapshot(forged)).not.toThrow();
        const reader = new ReplicationService(second);
        const before = reader.capture();
        const guard = second.getReplicationGuard();

        expect(() => reader.accept(forged)).toThrow(
          expect.objectContaining({ code: "REPLICATION_PUBLICATION" }),
        );

        expect(reader.capture()).toEqual(before);
        expect(second.getReplicationGuard()).toEqual(guard);
        expect(second.get(document.id)).toBeUndefined();
        expect(second.getReplicationOutbox()).toEqual([]);
      },
    );
  });
});
