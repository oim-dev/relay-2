import { describe, expect, test } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import { join } from "node:path";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import { BatchService, CommandExecutor } from "../../src/batch/batch";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

describe("Предметная репликация независимых SQLite", () => {
  test("разные поля и Markdown объединяются, повторный обмен не пишет revisions или outbox", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create(
          "document",
          { name: "Исходное имя", body: "a\nb\nc\n" },
          "seed",
        );
      },
      async ({ first, second, remote }) => {
        const left = new KnowledgeService(first);
        const right = new KnowledgeService(second);
        const original = left.get("document", "DOC-1");
        await left.update(
          "document",
          original.id,
          { name: "Локальное имя", body: "A\nb\nc\n" },
          { actor: "left", ifRevision: original.revision },
        );
        await right.update(
          "document",
          original.id,
          { summary: "Удалённое описание", body: "a\nb\nC\n" },
          { actor: "right", ifRevision: original.revision },
        );
        const a = new ReplicationService(first);
        const b = new ReplicationService(second);
        const published = b.prepare(remote).snapshot;
        b.accept(published);

        const prepared = a.prepare(published);

        expect(prepared.conflicts).toEqual([]);
        expect(
          prepared.snapshot.entities.find((entry) => entry.record.id === original.id)?.record.data,
        ).toMatchObject({
          name: "Локальное имя",
          summary: "Удалённое описание",
          body: "A\nb\nC\n",
        });
        a.accept(prepared.snapshot);
        b.accept(prepared.snapshot);
        const beforeA = first.get(original.id);
        const beforeB = second.get(original.id);
        const generationA = first.getGeneration();
        const generationB = second.getGeneration();
        expect(a.prepare(prepared.snapshot).snapshot).toEqual(prepared.snapshot);
        expect(b.prepare(prepared.snapshot).snapshot).toEqual(prepared.snapshot);
        a.accept(prepared.snapshot);
        b.accept(prepared.snapshot);
        expect(first.get(original.id)).toEqual(beforeA);
        expect(second.get(original.id)).toEqual(beforeB);
        expect(first.getGeneration()).toBe(generationA);
        expect(second.getGeneration()).toBe(generationB);
        expect(a.status().pending).toBe(0);
        expect(b.status().pending).toBe(0);
      },
    );
  });

  test("одновременные предварительные ключи уступают принятому remote без ложного алиаса", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const local = await new KnowledgeService(first).create(
          "document",
          { name: "Локальный", body: "DOC-1 — дословный Markdown" },
          "left",
        );
        const foreign = await new KnowledgeService(second).create(
          "document",
          { name: "Удалённый", body: "Принят первым" },
          "right",
        );
        expect(local.key).toBe(foreign.key);
        const a = new ReplicationService(first);
        const b = new ReplicationService(second);
        const published = b.prepare(remote).snapshot;
        b.accept(published);

        const prepared = a.prepare(published);
        a.accept(prepared.snapshot);

        expect(prepared.conflicts).toEqual([]);
        expect(first.get(local.id)?.key).toBe("DOC-2");
        expect(first.get("DOC-1")?.id).toBe(foreign.id);
        expect(first.get(local.id)?.data.body).toBe("DOC-1 — дословный Markdown");
        await expect(
          new KnowledgeService(first).update(
            "document",
            "DOC-1",
            { name: "Опасный старый запрос" },
            { actor: "left", ifRevision: 1 },
          ),
        ).rejects.toMatchObject({ code: "ADDRESS_GUARD_REQUIRED" });
        await expect(
          new CommandExecutor(first).execute(
            {
              op: "document.update",
              ref: "DOC-1",
              ifRevision: 1,
              input: { name: "Устаревший ввод" },
            },
            { actor: "left", expectedAddresses: [{ ref: "DOC-1", expectedId: local.id }] },
          ),
        ).rejects.toMatchObject({ code: "ADDRESS_CHANGED" });
        expect(first.get(foreign.id)?.data.name).toBe("Удалённый");
        const allowed = await new CommandExecutor(first).execute(
          {
            op: "document.update",
            ref: "document:DOC-1",
            ifRevision: 1,
            input: { name: "Проверенная новая цель" },
          },
          { actor: "left", expectedAddresses: [{ ref: "document:DOC-1", expectedId: foreign.id }] },
        );
        expect(allowed.items[0]?.id).toBe(foreign.id);
        expect(first.get(foreign.id)?.data.name).toBe("Проверенная новая цель");
        const reopened = ProjectDatabase.open(first.path);
        try {
          await expect(
            new KnowledgeService(reopened).update(
              "document",
              "DOC-1",
              { name: "Без guard после reopen" },
              { actor: "left", ifRevision: 2 },
            ),
          ).rejects.toMatchObject({ code: "ADDRESS_GUARD_REQUIRED" });
        } finally {
          reopened.close();
        }
      },
    );
  });

  test("параллельные immutable-комментарии объединяются без CAS содержания и имеют общий порядок", async () => {
    await withReplicationFixture(
      async (db) => {
        await new TasksService(db).create({ board: "product", title: "Обсуждение" }, "seed");
      },
      async ({ first, second, remote }) => {
        const a = new ReplicationService(first);
        const b = new ReplicationService(second);
        const task = new TasksService(first).get("PRODUCT-1");
        await new TasksService(first).comment(task.id, "Левый\n**точный**", "left");
        await new TasksService(second).comment(task.id, "Правый", "right");
        const published = b.prepare(remote).snapshot;
        b.accept(published);

        const candidate = a.prepare(published);
        a.accept(candidate.snapshot);
        b.accept(candidate.snapshot);

        expect(candidate.conflicts).toEqual([]);
        const journalA = new TasksService(first).get(task.id);
        const journalB = new TasksService(second).get(task.id);
        expect(journalA.revision).toBe(task.revision);
        expect(journalB.revision).toBe(task.revision);
        expect(journalA.data.comments.map((comment) => comment.body).sort()).toEqual([
          "Левый\n**точный**",
          "Правый",
        ]);
        expect(journalA.data.comments).toEqual(journalB.data.comments);
        expect(a.status().pending).toBe(0);
      },
    );
  });

  test("accept старого подготовленного кандидата сохраняет более позднюю запись в outbox", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("document", { name: "Имя", body: "Основа" }, "seed");
      },
      async ({ first, remote }) => {
        const knowledge = new KnowledgeService(first);
        const service = new ReplicationService(first);
        const original = knowledge.get("document", "DOC-1");
        const changed = await knowledge.update(
          "document",
          original.id,
          { name: "Первое" },
          { actor: "writer", ifRevision: original.revision },
        );
        const prepared = service.prepare(remote);
        await knowledge.update(
          "document",
          original.id,
          { body: "Поздняя запись" },
          { actor: "writer", ifRevision: changed.revision },
        );

        const accepted = service.accept(prepared.snapshot);

        expect(accepted.acknowledged).toHaveLength(1);
        expect(first.get(original.id)?.data).toMatchObject({
          name: "Первое",
          body: "Поздняя запись",
        });
        expect(service.status().pending).toBe(1);
        expect(service.prepare(prepared.snapshot).conflicts).toEqual([]);
      },
    );
  });

  test("конфликт блокирует свою причинную цепочку, но независимая запись проходит", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("feature", { name: "Основа" }, "seed");
      },
      async ({ first, second, remote }) => {
        const left = new KnowledgeService(first);
        const right = new KnowledgeService(second);
        const original = left.get("feature", "FEATURE-1");
        const changed = await left.update(
          "feature",
          original.id,
          { name: "Слева" },
          { actor: "left", ifRevision: original.revision },
        );
        await left.update(
          "feature",
          original.id,
          { summary: "Зависимая" },
          { actor: "left", ifRevision: changed.revision },
        );
        const independent = await left.create(
          "document",
          { name: "Независимый", body: "Доставка разрешена" },
          "left",
        );
        await right.update(
          "feature",
          original.id,
          { name: "Справа" },
          { actor: "right", ifRevision: original.revision },
        );
        const service = new ReplicationService(first);
        const published = new ReplicationService(second).prepare(remote).snapshot;

        const [conflictingSource, dependentSource, independentSource] =
          first.getReplicationOutbox();
        if (!conflictingSource || !dependentSource || !independentSource) {
          throw new Error("Нет исходной причинной цепочки");
        }

        const prepared = service.prepare(published);

        expect(prepared.conflicts.map((entry) => entry.code)).toEqual(["REPLICATION_CONFLICT"]);
        expect(prepared.selection.deferred).toEqual([dependentSource.id]);
        expect(prepared.selection.waiting).toEqual([
          {
            id: dependentSource.id,
            state: "pending",
            code: "REPLICATION_DEPENDENCY",
            message: "Изменение ожидает принятия причинной зависимости",
            dependencies: [conflictingSource.id],
          },
        ]);
        expect(prepared.included).toHaveLength(1);
        expect(prepared.snapshot.entities.some((entry) => entry.record.id === independent.id)).toBe(
          true,
        );
        const accepted = service.accept(prepared.snapshot);
        expect(accepted.acknowledged).toEqual([independentSource.id]);
        expect(first.getReplicationOutbox()).toEqual([conflictingSource, dependentSource]);
        expect(
          prepared.snapshot.entities.find((entry) => entry.record.id === original.id)?.record.data,
        ).toMatchObject({
          name: "Справа",
          summary: "",
        });
        expect(service.blocked()).toEqual(prepared.selection.waiting);
        expect(first.get(original.id)?.data.name).toBe("Слева");
        expect(service.status().pending).toBe(2);
        const conflict = service.conflicts()[0];
        if (conflict === undefined) {
          throw new Error("Отсутствует ожидаемый конфликт");
        }
        const current = left.get("feature", original.id);
        await left.update(
          "feature",
          original.id,
          { description: "Новая правка" },
          { actor: "left", ifRevision: current.revision },
        );
        expect(() =>
          service.resolve(
            conflict.id,
            { fingerprint: conflict.fingerprint, choice: "local" },
            "resolver",
          ),
        ).toThrow(expect.objectContaining({ code: "REPLICATION_STALE" }));
      },
    );
  });

  test("batch атомарен в outbox, check и replay не создают изменений, квитанция переживает восстановление", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote, directory }) => {
        const batch = new BatchService(first);
        const sync = new ReplicationService(first);
        const input = {
          version: 1,
          operations: [
            { op: "document.create", input: { name: "Один", body: "Первый" } },
            { op: "document.create", input: { name: "Два", body: "Второй" } },
          ],
        };
        const before = first.getGeneration();
        await batch.execute(input, { actor: "batch", check: true });
        expect(sync.status().pending).toBe(0);
        expect(first.getGeneration()).toBe(before);

        const result = await batch.execute(input, { actor: "batch", operationKey: "atomic-batch" });
        const changes = first.getReplicationOutbox();

        expect(changes).toHaveLength(1);
        expect(changes[0]?.entities).toHaveLength(2);
        expect(changes[0]?.receipts).toHaveLength(1);
        const generation = first.getGeneration();
        expect(
          (await batch.execute(input, { actor: "batch", operationKey: "atomic-batch" })).replayed,
        ).toBe(true);
        expect(first.getGeneration()).toBe(generation);
        expect(sync.status().pending).toBe(1);
        const published = sync.prepare(remote).snapshot;
        sync.accept(published);
        new ReplicationService(second).accept(published);
        const restored = ProjectDatabase.createReplica(
          join(directory, "restored.sqlite"),
          first.projectId,
        );
        try {
          new ReplicationService(restored).bootstrap(published, { chain: [remote] });
          expect(new BatchService(restored).getResult("atomic-batch")).toEqual({
            ...result,
            replayed: true,
          });
          expect(new ReplicationService(restored).status().pending).toBe(0);
        } finally {
          restored.close();
        }
      },
    );
  });
});
