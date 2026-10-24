import { describe, expect, test } from "bun:test";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

describe("Неизменяемые custom text решения", () => {
  test("независимое remote тело допускает retry того же решения с новым publication parent", async () => {
    await withReplicationFixture(
      async (db) => {
        const knowledge = new KnowledgeService(db);
        await knowledge.create("document", { name: "Конфликт", body: "Основа" }, "seed");
        await knowledge.create("document", { name: "Независимый", body: "Исходный" }, "seed");
      },
      async ({ first, second, remote }) => {
        const left = new KnowledgeService(first);
        const right = new KnowledgeService(second);
        await left.update("document", "DOC-1", { body: "Слева" }, { actor: "left", ifRevision: 1 });
        await right.update(
          "document",
          "DOC-1",
          { body: "Справа" },
          { actor: "right", ifRevision: 1 },
        );
        const writer = new ReplicationService(second);
        const published = writer.prepare(remote).snapshot;
        writer.accept(published);
        const sync = new ReplicationService(first);
        const conflict = sync.prepare(published).conflicts[0];
        if (conflict === undefined) {
          throw new Error("Нет конфликта");
        }
        const resolved = sync.resolve(
          conflict.id,
          { fingerprint: conflict.fingerprint, choice: "local" },
          "resolver",
        );
        const resolutionId = resolved.snapshot.publication?.changes[0]?.resolution?.resolutionId;
        sync.accept(published);
        await right.update(
          "document",
          "DOC-2",
          { body: "Независимая новая версия" },
          { actor: "right", ifRevision: 1 },
        );
        const advanced = writer.prepare(published).snapshot;

        const retried = sync.prepare(advanced);

        expect(retried.conflicts).toEqual([]);
        expect(retried.snapshot.publication?.changes[0]?.resolution?.resolutionId).toBe(
          resolutionId,
        );
        sync.accept(retried.snapshot);
        writer.accept(retried.snapshot, { chain: [advanced] });
        expect(right.get("document", "DOC-1").data.body).toBe("Слева");
        expect(left.get("document", "DOC-2").data.body).toBe("Независимая новая версия");
        expect(sync.status().pending).toBe(0);
      },
    );
  });

  test("patch одной boundary сохраняет весь batch, original source/receipt и авторство ручной поправки", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create(
          "document",
          { name: "Общий", body: "Основа" },
          "seed",
        );
        await new TasksService(db).create({ title: "Атомарный спутник" }, "seed");
      },
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const doc = knowledge.get("document", "DOC-1");
        const task = new TasksService(first).get("PRODUCT-1");
        const result = await new BatchService(first).execute(
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
                input: { description: "В том же пакете" },
              },
            ],
          },
          { actor: "left", operationKey: "custom-atomic" },
        );
        const original = first.getReplicationOutbox()[0];
        const receipt = first.getBatchReceipt("custom-atomic");
        await new KnowledgeService(second).update(
          "document",
          doc.id,
          { body: "Удалённый" },
          { actor: "right", ifRevision: second.get(doc.id)?.revision ?? 0 },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const sync = new ReplicationService(first);
        const conflict = sync.prepare(published).conflicts[0];
        if (conflict === undefined) {
          throw new Error("Нет конфликта");
        }
        const body = "Объединённый\nточно\ud800";

        const resolved = sync.resolve(
          conflict.id,
          {
            fingerprint: conflict.fingerprint,
            choice: "custom",
            patch: [{ transition: 0, entityId: doc.id, field: "body", value: body }],
          },
          "resolver",
        );

        expect(resolved.conflicts).toEqual([]);
        expect(resolved.included).toEqual([conflict.id]);
        expect(first.getReplicationOutbox()[0]).toEqual(original);
        expect(first.getBatchReceipt("custom-atomic")).toEqual(receipt);
        const resolution = resolved.snapshot.publication?.changes[0]?.resolution;
        expect(resolution?.choice).toBe("custom");
        expect(resolved.snapshot.publication?.accepted[0]?.resolutionId).toBe(
          resolution?.resolutionId,
        );
        expect(
          resolved.snapshot.entities.find((entry) => entry.record.id === doc.id)?.record,
        ).toMatchObject({
          data: { body },
          updatedBy: "resolver",
          updatedAt: resolution?.createdAt,
        });
        sync.accept(published);
        expect(sync.prepare(published).snapshot).toEqual(resolved.snapshot);

        sync.accept(resolved.snapshot);
        new ReplicationService(second).accept(resolved.snapshot, { chain: [published] });
        expect(first.get(doc.id)?.data.body).toBe(body);
        expect(second.get(doc.id)?.data.body).toBe(body);
        expect(second.get(task.id)?.data.description).toBe("В том же пакете");
        expect(new BatchService(second).getResult("custom-atomic")).toEqual({
          ...result,
          replayed: true,
        });
        expect(second.getBatchReceipt("custom-atomic")).toEqual(receipt);
        expect(sync.status().pending).toBe(0);
      },
    );
  });

  test("custom не меняет не затронутую запись или поле и не сохраняет отклонённое решение", async () => {
    await withReplicationFixture(
      async (db) => {
        const knowledge = new KnowledgeService(db);
        await knowledge.create("document", { name: "Конфликтный", body: "Основа" }, "seed");
        await knowledge.create("document", { name: "Другой", body: "Сохранить" }, "seed");
      },
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const doc = knowledge.get("document", "DOC-1");
        const other = knowledge.get("document", "DOC-2");
        await knowledge.update(
          "document",
          doc.id,
          { body: "Слева" },
          { actor: "left", ifRevision: doc.revision },
        );
        await new KnowledgeService(second).update(
          "document",
          doc.id,
          { body: "Справа" },
          { actor: "right", ifRevision: second.get(doc.id)?.revision ?? 0 },
        );
        const sync = new ReplicationService(first);
        const conflict = sync.prepare(new ReplicationService(second).prepare(remote).snapshot)
          .conflicts[0];
        if (conflict === undefined) {
          throw new Error("Нет конфликта");
        }
        const before = sync.capture();
        const original = first.getReplicationOutbox();

        expect(() =>
          sync.resolve(
            conflict.id,
            {
              fingerprint: conflict.fingerprint,
              choice: "custom",
              patch: [{ transition: 0, entityId: other.id, field: "body", value: "Нельзя" }],
            },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_RESOLUTION_SCOPE" }));
        expect(() =>
          sync.resolve(
            conflict.id,
            {
              fingerprint: conflict.fingerprint,
              choice: "custom",
              patch: [
                { transition: 0, entityId: doc.id, field: "name", value: "Не менялось source" },
              ],
            },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_RESOLUTION_SCOPE" }));

        expect(sync.capture()).toEqual(before);
        expect(first.getReplicationOutbox()).toEqual(original);
        expect(first.getReplicationDecisions()).toEqual([]);
      },
    );
  });

  test("приём старой публикации не забывает более позднее custom решение и позднюю предметную запись", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create(
          "document",
          { name: "Общий", body: "Основа" },
          "seed",
        );
      },
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const doc = knowledge.get("document", "DOC-1");
        await knowledge.update(
          "document",
          doc.id,
          { body: "Локальный" },
          { actor: "left", ifRevision: doc.revision },
        );
        await new KnowledgeService(second).update(
          "document",
          doc.id,
          { body: "Удалённый" },
          { actor: "right", ifRevision: second.get(doc.id)?.revision ?? 0 },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const sync = new ReplicationService(first);
        const initial = sync.prepare(published).conflicts[0];
        if (initial === undefined) {
          throw new Error("Нет конфликта");
        }
        const firstDecision = sync.resolve(
          initial.id,
          {
            fingerprint: initial.fingerprint,
            choice: "custom",
            patch: [{ transition: 0, entityId: doc.id, field: "body", value: "Первое решение" }],
          },
          "resolver",
        );
        await knowledge.update(
          "document",
          doc.id,
          { summary: "Поздняя запись" },
          { actor: "late", ifRevision: knowledge.get("document", doc.id).revision },
        );
        const refreshed = sync
          .prepare(published)
          .conflicts.find((entry) => entry.id === initial.id);
        if (refreshed === undefined) {
          throw new Error("Нет нового fingerprint");
        }
        const secondDecision = sync.resolve(
          initial.id,
          {
            fingerprint: refreshed.fingerprint,
            choice: "custom",
            patch: [{ transition: 0, entityId: doc.id, field: "body", value: "Позднее решение" }],
          },
          "resolver",
        );
        const pendingId = secondDecision.snapshot.publication?.changes[0]?.resolution?.resolutionId;

        const accepted = sync.accept(firstDecision.snapshot);

        expect(accepted.acknowledged).toEqual([]);
        const stale = sync
          .conflicts()
          .find((entry) => entry.code === "REPLICATION_RESOLUTION_STALE");
        if (stale === undefined) {
          throw new Error("Позднее решение потеряно");
        }
        expect(stale.pendingResolution?.resolutionId).toBe(pendingId);
        expect(stale.pendingResolution).toMatchObject({
          choice: "custom",
          patch: [{ value: "Позднее решение" }],
        });
        expect(first.get(doc.id)?.data.summary).toBe("Поздняя запись");
        expect(sync.status().pending).toBe(2);
        expect(() =>
          sync.resolve(stale.id, { fingerprint: stale.fingerprint, choice: "local" }, "resolver"),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_ALREADY_ACCEPTED" }));

        sync.resolve(stale.id, { fingerprint: stale.fingerprint, choice: "remote" }, "resolver");
        const adopted = sync.accept(firstDecision.snapshot);
        expect(adopted.acknowledged).toEqual([initial.id]);
        expect(first.get(doc.id)?.data).toMatchObject({
          body: "Первое решение",
          summary: "Поздняя запись",
        });
        expect(sync.status().pending).toBe(1);
      },
    );
  });
});
