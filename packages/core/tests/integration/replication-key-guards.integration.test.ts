import { describe, expect, spyOn, test } from "bun:test";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

describe("Границы ключевого решения репликации", () => {
  test("список ключей читает сохранённые конфликты и адреса без полного snapshot и outbox", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const local = await new KnowledgeService(first).create(
          "document",
          { name: "Локальный", body: "Тело" },
          "left",
        );
        const foreign = await new KnowledgeService(second).create(
          "document",
          { name: "Удалённый", body: "Другое тело" },
          "right",
        );
        const sync = new ReplicationService(first);
        sync.prepare(new ReplicationService(second).prepare(remote).snapshot);
        const capture = spyOn(first, "captureReplication");
        const outbox = spyOn(first, "getReplicationOutbox");
        const state = spyOn(first, "getReplicationState");
        const addresses = spyOn(first, "getReplicationKeyAddresses");
        try {
          const conflicts = sync.keyConflicts();

          expect(conflicts).toHaveLength(1);
          expect(conflicts[0]?.collisions).toEqual([
            {
              entityId: local.id,
              key: "DOC-1",
              acceptedOwnerId: foreign.id,
              suggestedKey: "DOC-2",
            },
          ]);
          expect(capture).not.toHaveBeenCalled();
          expect(outbox).not.toHaveBeenCalled();
          expect(state).not.toHaveBeenCalled();
          expect(addresses).toHaveBeenCalledTimes(1);
        } finally {
          capture.mockRestore();
          outbox.mockRestore();
          state.mockRestore();
          addresses.mockRestore();
        }
      },
    );
  });

  test("выбранный pending-ключ другого source занят даже до его локального импорта", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const local = await knowledge.create("document", { name: "Первый", body: "A" }, "left");
        const other = await knowledge.create("document", { name: "Второй", body: "B" }, "left");
        const foreign = new KnowledgeService(second);
        await foreign.create("document", { name: "Удалённый первый", body: "C" }, "right");
        await foreign.create("document", { name: "Удалённый второй", body: "D" }, "right");
        const sync = new ReplicationService(first);
        sync.prepare(new ReplicationService(second).prepare(remote).snapshot);
        const firstConflict = sync
          .keyConflicts()
          .find((entry) => entry.collisions[0]?.entityId === local.id);
        const secondConflict = sync
          .keyConflicts()
          .find((entry) => entry.collisions[0]?.entityId === other.id);
        if (firstConflict === undefined || secondConflict === undefined) {
          throw new Error("Нет двух коллизий");
        }
        sync.resolveKeys(
          firstConflict.id,
          {
            fingerprint: firstConflict.fingerprint,
            assignments: [{ entityId: local.id, key: "DOC-3" }],
          },
          "resolver",
        );
        const guard = first.getReplicationGuard();
        const selected = first.getReplicationDecision(firstConflict.id);
        const capture = spyOn(first, "captureReplication");
        const outbox = spyOn(first, "getReplicationOutbox");
        const decisions = spyOn(first, "getReplicationDecisions");
        let suggestedKey: string | undefined;
        try {
          suggestedKey = sync.keyConflicts().find((entry) => entry.id === secondConflict.id)
            ?.collisions[0]?.suggestedKey;
          expect(suggestedKey).toBe("DOC-4");
          expect(capture).not.toHaveBeenCalled();
          expect(outbox).not.toHaveBeenCalled();
          expect(decisions).not.toHaveBeenCalled();
        } finally {
          capture.mockRestore();
          outbox.mockRestore();
          decisions.mockRestore();
        }

        expect(() =>
          sync.resolveKeys(
            secondConflict.id,
            {
              fingerprint: secondConflict.fingerprint,
              assignments: [{ entityId: other.id, key: "DOC-3" }],
            },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_ADDRESS" }));

        expect(first.getReplicationGuard()).toEqual(guard);
        expect(first.getReplicationDecision(secondConflict.id)).toBeUndefined();
        expect(first.getReplicationDecision(firstConflict.id)).toEqual(selected);
        expect(knowledge.get("document", local.id).key).toBe("DOC-1");
        expect(knowledge.get("document", other.id).key).toBe("DOC-2");
        if (suggestedKey === undefined) {
          throw new Error("Нет свободного предложения после первого решения");
        }
        const resolved = sync.resolveKeys(
          secondConflict.id,
          {
            fingerprint: secondConflict.fingerprint,
            assignments: [{ entityId: other.id, key: suggestedKey }],
          },
          "resolver",
        );
        expect(resolved.conflicts).toEqual([]);
        expect(resolved.included).toEqual([firstConflict.id, secondConflict.id]);
      },
    );
  });

  test("выбор нового ключа не разрешает конфликт содержимого соседнего эффекта batch", async () => {
    await withReplicationFixture(
      async (database) => {
        await new KnowledgeService(database).create("feature", { name: "Основа" }, "seed");
      },
      async ({ first, second, remote }) => {
        const result = await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "feature.update",
                ref: "FEATURE-1",
                ifRevision: 1,
                input: { name: "Локальная правка" },
              },
              { op: "document.create", input: { name: "Локальный", body: "Атомарный спутник" } },
            ],
          },
          { actor: "left", operationKey: "mixed-keys-content" },
        );
        const documentId = result.items[1]?.id;
        if (documentId === undefined) {
          throw new Error("Нет документа");
        }
        const foreign = new KnowledgeService(second);
        await foreign.update(
          "feature",
          "FEATURE-1",
          { name: "Удалённая правка" },
          { actor: "right", ifRevision: 1 },
        );
        await foreign.create("document", { name: "Удалённый", body: "Принят первым" }, "right");
        const sync = new ReplicationService(first);
        const prepared = sync.prepare(new ReplicationService(second).prepare(remote).snapshot);
        expect(prepared.conflicts.map((entry) => entry.code)).toEqual(["REPLICATION_CONFLICT"]);
        const conflict = sync.keyConflicts()[0];
        if (conflict === undefined) {
          throw new Error("Нет коллизии ключа в атомарном пакете");
        }
        const before = sync.capture();
        const pending = first.getReplicationOutbox();

        expect(() =>
          sync.resolveKeys(
            conflict.id,
            {
              fingerprint: conflict.fingerprint,
              assignments: [{ entityId: documentId, key: "DOC-9" }],
            },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_CONFLICT" }));

        expect(sync.capture()).toEqual(before);
        expect(first.getReplicationOutbox()).toEqual(pending);
        expect(first.getReplicationDecisions()).toEqual([]);
        expect(new BatchService(first).getResult("mixed-keys-content")).toEqual({
          ...result,
          replayed: true,
        });
      },
    );
  });

  test("поздний выбор не заменяет уже принятое решение и остаётся доступным отдельно от серверного DTO", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const local = await new KnowledgeService(first).create(
          "document",
          { name: "Локальный", body: "Содержание" },
          "left",
        );
        await new KnowledgeService(second).create(
          "document",
          { name: "Удалённый", body: "Принят первым" },
          "right",
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const sync = new ReplicationService(first);
        sync.prepare(published);
        const conflict = sync.keyConflicts()[0];
        if (conflict === undefined) {
          throw new Error("Нет коллизии");
        }
        const firstChoice = sync.resolveKeys(
          conflict.id,
          {
            fingerprint: conflict.fingerprint,
            assignments: [{ entityId: local.id, key: "DOC-2" }],
          },
          "resolver",
        );
        const laterInput = {
          fingerprint: conflict.fingerprint,
          assignments: [{ entityId: local.id, key: "DOC-3" }],
        };
        sync.resolveKeys(conflict.id, laterInput, "resolver");
        const later = first.getReplicationDecision(conflict.id);

        const accepted = sync.accept(firstChoice.snapshot);

        expect(accepted.acknowledged).toEqual([]);
        expect(accepted.reconciled).toBe(false);
        const storedConflict = sync.conflicts()[0];
        if (storedConflict === undefined) {
          throw new Error("Позднее решение должно остаться конфликтом");
        }
        expect(storedConflict.code).toBe("REPLICATION_RESOLUTION_STALE");
        expect(storedConflict.pendingResolution).toBeUndefined();
        expect(sync.keyConflicts()[0]).toMatchObject({
          code: "REPLICATION_RESOLUTION_STALE",
          pendingResolution: {
            resolutionId: later?.resolutionId,
            assignments: [{ entityId: local.id, key: "DOC-3" }],
          },
        });
        const before = sync.capture();
        expect(() => sync.resolveKeys(conflict.id, laterInput, "resolver")).toThrow(
          expect.objectContaining({ code: "REPLICATION_ALREADY_ACCEPTED" }),
        );
        expect(sync.capture()).toEqual(before);
        expect(first.getReplicationDecision(conflict.id)).toEqual(later);

        sync.resolve(
          storedConflict.id,
          {
            fingerprint: storedConflict.fingerprint,
            choice: "remote",
          },
          "resolver",
        );
        sync.accept(firstChoice.snapshot);
        expect(first.get(local.id)?.key).toBe("DOC-2");
        expect(sync.status().pending).toBe(0);
        expect(sync.keyConflicts()).toEqual([]);
      },
    );
  });
});
