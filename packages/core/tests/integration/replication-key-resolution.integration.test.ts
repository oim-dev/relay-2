import { describe, expect, test } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import { join } from "node:path";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

describe("Явное разрешение коллизий ключей", () => {
  test("атомарный выбор двух ключей сохраняет разные задачи, связи, авторство, source и receipt", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote, directory }) => {
        const batch = new BatchService(first);
        const result = await batch.execute(
          {
            version: 1,
            operations: [
              {
                op: "task.create",
                as: "parent",
                input: { title: "Локальный родитель", description: "PRODUCT-1 дословно" },
              },
              {
                op: "task.create",
                input: { title: "Локальный ребёнок", parent: { $ref: "parent" } },
              },
            ],
          },
          { actor: "left", operationKey: "keys-batch" },
        );
        const parentId = result.items[0]?.id;
        const childId = result.items[1]?.id;
        const source = first.getReplicationOutbox()[0];
        if (parentId === undefined || childId === undefined || source === undefined) {
          throw new Error("Нет исходного атомарного пакета");
        }
        const tasks = new TasksService(first);
        const parent = tasks.get(parentId);
        const child = tasks.get(childId);
        const receipt = first.getBatchReceipt("keys-batch");
        const foreign = await new TasksService(second).create(
          { title: "Удалённый родитель" },
          "right",
        );
        const foreignChild = await new TasksService(second).create(
          { title: "Удалённый ребёнок" },
          "right",
        );
        const peer = new ReplicationService(second);
        const published = peer.prepare(remote).snapshot;
        peer.accept(published);
        const sync = new ReplicationService(first);
        const before = sync.capture();
        const generation = first.getGeneration();

        const prepared = sync.prepare(published);
        const accepted = sync.accept(published);

        expect(prepared.included).toEqual([]);
        expect(prepared.conflicts.map((entry) => entry.code)).toEqual([
          "REPLICATION_KEY_COLLISION",
        ]);
        expect(accepted.reconciled).toBe(false);
        expect(first.getGeneration()).toBe(generation);
        expect(sync.capture()).toEqual({ ...before, confirmations: published.confirmations });
        const conflict = sync.keyConflicts()[0];
        if (conflict === undefined) {
          throw new Error("Нет адресного конфликта");
        }
        expect(conflict.collisions).toHaveLength(2);
        expect(conflict.collisions.map((entry) => entry.suggestedKey).sort()).toEqual([
          "PRODUCT-3",
          "PRODUCT-4",
        ]);
        expect(conflict.collisions).toContainEqual(
          expect.objectContaining({
            entityId: parentId,
            key: "PRODUCT-1",
            acceptedOwnerId: foreign.id,
          }),
        );
        expect(() =>
          sync.resolveKeys(
            conflict.id,
            {
              fingerprint: conflict.fingerprint,
              assignments: [{ entityId: parentId, key: "PRODUCT-10" }],
            },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_RESOLUTION_SCOPE" }));
        expect(first.getReplicationDecisions()).toEqual([]);
        expect(() =>
          sync.resolve(
            conflict.id,
            {
              fingerprint: conflict.fingerprint,
              choice: "local",
            },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_KEY_COLLISION" }));
        const decision = {
          fingerprint: conflict.fingerprint,
          assignments: [
            { entityId: parentId, key: "PRODUCT-10" },
            { entityId: childId, key: "PRODUCT-20" },
          ],
        };

        const resolved = sync.resolveKeys(conflict.id, decision, "resolver");

        expect(resolved.conflicts).toEqual([]);
        expect(resolved.included).toEqual([source.id]);
        expect(first.getReplicationOutbox()).toEqual([source]);
        expect(first.getBatchReceipt("keys-batch")).toEqual(receipt);
        expect(resolved.snapshot.publication?.changes[0]?.source).toEqual(source);
        const guard = first.getReplicationGuard();
        expect(
          sync.resolveKeys(
            conflict.id,
            {
              ...decision,
              assignments: [...decision.assignments].reverse(),
            },
            "resolver",
          ).snapshot,
        ).toEqual(resolved.snapshot);
        expect(first.getReplicationGuard()).toEqual(guard);
        expect(sync.accept(resolved.snapshot).reconciled).toBe(true);
        peer.accept(resolved.snapshot);

        for (const database of [first, second]) {
          const read = new TasksService(database);
          expect(read.get(parentId)).toMatchObject({
            id: parentId,
            key: "PRODUCT-10",
            data: parent.data,
            createdAt: parent.createdAt,
            createdBy: parent.createdBy,
            updatedAt: parent.updatedAt,
            updatedBy: parent.updatedBy,
          });
          expect(read.get(childId)).toMatchObject({
            id: childId,
            key: "PRODUCT-20",
            data: child.data,
            createdAt: child.createdAt,
            createdBy: child.createdBy,
          });
          expect(read.get("PRODUCT-1")).toEqual(foreign);
          expect(read.get("PRODUCT-2")).toEqual(foreignChild);
          expect(new BatchService(database).getResult("keys-batch")).toEqual({
            ...result,
            replayed: true,
          });
          expect(database.getBatchReceipt("keys-batch")).toEqual(receipt);
          expect(new ReplicationService(database).status().pending).toBe(0);
        }
        const reopened = ProjectDatabase.open(first.path);
        const restored = ProjectDatabase.createReplica(
          join(directory, "key-restored.sqlite"),
          first.projectId,
        );
        try {
          const reader = new ReplicationService(reopened);
          const stable = reopened.getReplicationGuard();
          expect(reader.resolveKeys(conflict.id, decision, "resolver").included).toEqual([]);
          reader.accept(resolved.snapshot);
          expect(reopened.getReplicationGuard()).toEqual(stable);
          new ReplicationService(restored).bootstrap(
            JSON.parse(JSON.stringify(resolved.snapshot)),
            {
              chain: [remote, published],
            },
          );
          expect(new TasksService(restored).get(childId).data.parentId).toBe(parentId);
          expect(new BatchService(restored).getResult("keys-batch")).toEqual({
            ...result,
            replayed: true,
          });
          expect(new ReplicationService(restored).status().pending).toBe(0);
        } finally {
          restored.close();
          reopened.close();
        }
      },
    );
  });

  test("поздняя локальная правка делает решение stale, свежий выбор сохраняет зависимое содержание", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const local = await knowledge.create(
          "document",
          { name: "Локальный", body: "Исходный" },
          "left",
        );
        await new KnowledgeService(second).create(
          "document",
          { name: "Удалённый", body: "Другой" },
          "right",
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const sync = new ReplicationService(first);
        sync.prepare(published);
        const old = sync.keyConflicts()[0];
        if (old === undefined) {
          throw new Error("Нет коллизии");
        }
        await knowledge.update(
          "document",
          local.id,
          { body: "Поздний текст DOC-1" },
          { actor: "editor", ifRevision: local.revision },
        );
        const before = sync.capture();
        const pending = first.getReplicationOutbox();
        const [creation, dependent] = pending;
        if (creation === undefined || dependent === undefined) {
          throw new Error("Нет исходного создания и зависимого изменения");
        }

        expect(() =>
          sync.resolveKeys(
            old.id,
            {
              fingerprint: old.fingerprint,
              assignments: [{ entityId: local.id, key: "DOC-7" }],
            },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_STALE" }));

        expect(sync.capture()).toEqual(before);
        expect(first.getReplicationOutbox()).toEqual(pending);
        expect(first.getReplicationDecisions()).toEqual([]);
        sync.prepare(published);
        const current = sync.keyConflicts()[0];
        if (current === undefined) {
          throw new Error("Нет свежего конфликта");
        }
        expect(current.fingerprint).not.toBe(old.fingerprint);
        const resolved = sync.resolveKeys(
          current.id,
          {
            fingerprint: current.fingerprint,
            assignments: [{ entityId: local.id, key: "DOC-7" }],
          },
          "resolver",
          { budget: { maxChangesets: 1 } },
        );
        expect(resolved.included).toEqual([creation.id]);
        expect(resolved.selection.hasMore).toBe(true);
        sync.accept(resolved.snapshot);
        expect(knowledge.get("document", local.id)).toMatchObject({
          key: "DOC-7",
          data: { body: "Поздний текст DOC-1" },
          updatedBy: "editor",
        });
        expect(first.getReplicationOutbox()).toEqual([dependent]);
        const tail = sync.prepare(resolved.snapshot);
        expect(tail.conflicts).toEqual([]);
        sync.accept(tail.snapshot);
        expect(sync.status().pending).toBe(0);
      },
    );
  });

  test("занятый локальный ключ и сохранённый удалённый alias отклоняются без записи решения", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const local = await knowledge.create(
          "document",
          { name: "Локальный", body: "Текст" },
          "left",
        );
        const other = await knowledge.create(
          "document",
          { name: "Сосед", body: "Сохранить" },
          "left",
        );
        await knowledge.rename("document", other.id, "DOC-7", {
          actor: "left",
          ifRevision: other.revision,
        });
        const remoteKnowledge = new KnowledgeService(second);
        await remoteKnowledge.create("document", { name: "Принят", body: "Чужой" }, "right");
        await remoteKnowledge.create("document", { name: "Сосед remote", body: "Второй" }, "right");
        const reservation = await remoteKnowledge.create(
          "document",
          { name: "Резерв", body: "История" },
          "right",
        );
        await remoteKnowledge.rename("document", reservation.id, "DOC-9", {
          actor: "right",
          ifRevision: reservation.revision,
        });
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const sync = new ReplicationService(first);
        sync.prepare(published);
        const conflict = sync
          .keyConflicts()
          .find((entry) => entry.collisions.some((item) => item.entityId === local.id));
        if (conflict === undefined) {
          throw new Error("Нет коллизии");
        }
        const before = sync.capture();
        const guard = first.getReplicationGuard();

        expect(() =>
          sync.resolveKeys(
            conflict.id,
            {
              fingerprint: conflict.fingerprint,
              assignments: [{ entityId: local.id, key: "DOC-7" }],
            },
            "resolver",
          ),
        ).toThrow(
          expect.objectContaining({
            code: "REPLICATION_ADDRESS",
            details: { ref: "DOC-7", entityId: local.id, owner: other.id },
          }),
        );
        expect(() =>
          sync.resolveKeys(
            conflict.id,
            {
              fingerprint: conflict.fingerprint,
              assignments: [{ entityId: local.id, key: "DOC-3" }],
            },
            "resolver",
          ),
        ).toThrow(
          expect.objectContaining({
            code: "REPLICATION_ADDRESS",
            details: { ref: "DOC-3", entityId: local.id, owner: reservation.id },
          }),
        );

        expect(sync.capture()).toEqual(before);
        expect(first.getReplicationGuard()).toEqual(guard);
        expect(first.getReplicationDecisions()).toEqual([]);
      },
    );
  });

  test("новое принятое назначение инвалидирует сохранённый выбор, новый fingerprint не обходит занятость", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const local = await new KnowledgeService(first).create(
          "document",
          { name: "Локальный", body: "Текст" },
          "left",
        );
        const remoteKnowledge = new KnowledgeService(second);
        await remoteKnowledge.create("document", { name: "Принят", body: "Чужой" }, "right");
        const peer = new ReplicationService(second);
        const published = peer.prepare(remote).snapshot;
        peer.accept(published);
        const sync = new ReplicationService(first);
        sync.prepare(published);
        const conflict = sync.keyConflicts()[0];
        if (conflict === undefined) {
          throw new Error("Нет коллизии");
        }
        const decision = {
          fingerprint: conflict.fingerprint,
          assignments: [{ entityId: local.id, key: "DOC-2" }],
        };
        sync.resolveKeys(conflict.id, decision, "resolver");
        const original = first.getReplicationDecision(conflict.id);
        await remoteKnowledge.create(
          "document",
          { name: "Занял предложение", body: "Сохранить" },
          "right",
        );
        const advanced = peer.prepare(published).snapshot;

        const retried = sync.prepare(advanced);

        expect(retried.included).toEqual([]);
        expect(retried.conflicts.map((entry) => entry.code)).toEqual(["REPLICATION_KEY_COLLISION"]);
        const before = sync.capture();
        expect(() => sync.resolveKeys(conflict.id, decision, "resolver")).toThrow(
          expect.objectContaining({ code: "REPLICATION_STALE" }),
        );
        const current = sync.keyConflicts()[0];
        if (current === undefined) {
          throw new Error("Нет обновлённой коллизии");
        }
        expect(current.collisions[0]?.suggestedKey).toBe("DOC-3");
        expect(() =>
          sync.resolveKeys(
            current.id,
            { ...decision, fingerprint: current.fingerprint },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_ADDRESS" }));
        expect(first.getReplicationDecision(conflict.id)).toEqual(original);
        expect(sync.capture()).toEqual(before);
      },
    );
  });
});
