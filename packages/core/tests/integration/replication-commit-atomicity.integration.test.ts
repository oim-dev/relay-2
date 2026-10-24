import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

describe("Атомарность приёма публикации SQLite", () => {
  test("поздний отказ ACK откатывает импорт и состояние репликации, повтор сохраняет весь пакет", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create(
          "document",
          { name: "Общий", body: "Исходное тело" },
          "seed",
        );
      },
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const document = knowledge.get("document", "DOC-1");
        const remoteDocument = new KnowledgeService(second).get("document", document.id);
        await knowledge.update(
          "document",
          document.id,
          { summary: "Локальная правка" },
          { actor: "local", ifRevision: document.revision },
        );
        const result = await new BatchService(second).execute(
          {
            version: 1,
            operations: [
              {
                op: "document.update",
                ref: document.id,
                ifRevision: remoteDocument.revision,
                input: { body: "Удалённое тело" },
              },
              {
                op: "document.create",
                input: { name: "Связанный", body: "Спутник", targets: [document.id] },
              },
            ],
          },
          { actor: "remote", operationKey: "remote-atomic" },
        );
        const createdId = result.items[1]?.id;
        const receipt = second.getBatchReceipt("remote-atomic");
        if (createdId === undefined || receipt === undefined) {
          throw new Error("Пакет не сохранил ожидаемые документ и квитанцию");
        }
        const left = new ReplicationService(first);
        const right = new ReplicationService(second);
        const published = right.prepare(remote).snapshot;
        right.accept(published);
        const prepared = left.prepare(published);
        expect(prepared.conflicts).toEqual([]);
        const candidate = prepared.snapshot;
        const incomingComponents = candidate.components?.filter(
          (part) => part.ownerId === createdId,
        );
        if (incomingComponents === undefined || incomingComponents.length === 0) {
          throw new Error("Кандидат не содержит первичных частей связанного документа");
        }
        const before = {
          snapshot: left.capture(),
          document: first.get(document.id),
          components: first.getComponents([document.id, createdId]),
          receipt: first.getBatchReceipt("remote-atomic"),
          state: first.getReplicationState(),
          outbox: first.getReplicationOutbox(),
          generation: first.getGeneration(),
        };
        const raw = new Database(first.path, { create: false, readwrite: true });
        try {
          // DELETE outbox следует после import и записи base: отказ проверяет общую транзакцию,
          // а не preflight. Дополнительное raw-соединение принадлежит тесту и закрывается до fixture.
          raw.exec(
            "CREATE TRIGGER fail_replication_ack BEFORE DELETE ON replication_outbox BEGIN SELECT RAISE(ABORT, 'fixture: acknowledgement failure'); END",
          );

          expect(() => left.accept(candidate)).toThrow(
            expect.objectContaining({
              code: "CONFLICT",
              details: expect.objectContaining({ reason: "fixture: acknowledgement failure" }),
            }),
          );

          expect(left.capture()).toEqual(before.snapshot);
          expect(first.get(document.id)).toEqual(before.document);
          expect(first.get(createdId)).toBeUndefined();
          expect(first.getComponents([document.id, createdId])).toEqual(before.components);
          expect(first.getBatchReceipt("remote-atomic")).toEqual(before.receipt);
          expect(first.getReplicationState()).toEqual(before.state);
          expect(first.getReplicationOutbox()).toEqual(before.outbox);
          expect(first.getGeneration()).toBe(before.generation);
          raw.exec("DROP TRIGGER fail_replication_ack");

          const accepted = left.accept(candidate);

          expect(accepted.acknowledged).toEqual(before.outbox.map((change) => change.id));
          expect(first.get(document.id)?.data).toMatchObject({
            body: "Удалённое тело",
            summary: "Локальная правка",
          });
          expect(knowledge.get("document", createdId).data).toMatchObject({
            name: "Связанный",
            body: "Спутник",
            relations: [{ target: { kind: "document", id: document.id }, type: "documents" }],
          });
          expect(first.getComponents([createdId])).toEqual(incomingComponents);
          expect(first.getBatchReceipt("remote-atomic")).toEqual(receipt);
          expect(new BatchService(first).getResult("remote-atomic")).toEqual({
            ...result,
            replayed: true,
          });
          expect(first.getReplicationState().base).toEqual(candidate);
          expect(first.getReplicationOutbox()).toEqual([]);
        } finally {
          raw.close();
        }
      },
    );
  });
});
