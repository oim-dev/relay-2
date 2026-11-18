import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { EntityRecord } from "@relay/contracts";
import { ProjectDatabase, snapshotToPortableRows } from "@relay/storage";
import { BatchService } from "../../src/batch/batch";
import { TasksService } from "../../src/tasks/tasks";
import { ReplicationService } from "../../src/replication/replication";
import { validatePublicationEnvelope } from "../../src/replication/publication-envelope";
import { withReplicationFixture } from "./helpers/replication-fixture";

const receipt = {
  operationKey: "exact-receipt",
  requestJson: '{ "z": "запрос", "a": "\\ud800" }\n',
  resultJson: '{ "revision": 77, "body": "строка\\r\\n" }\n',
};

/**
 * Создаёт одну задачу для сценариев publication; принятие исходного снимка выполняет fixture.
 */
async function seedTask(db: ProjectDatabase): Promise<void> {
  await new TasksService(db).create({ title: "Исходная задача" }, "seed");
}

/**
 * Выполняет ровно одну синхронную Storage mutation для проверки capture внутри transaction.
 * Текущая карточка передана явно; комментарий/квитанция не повышают её CAS.
 */
function mutateStoredTask(
  db: ProjectDatabase,
  task: EntityRecord,
  kind: "owner" | "comment" | "receipt",
): void {
  if (kind === "owner") {
    db.update(
      { ...task, revision: task.revision + 1, data: { ...task.data, description: "Правка" } },
      task.revision,
    );
  } else if (kind === "comment") {
    db.appendTaskComment(task.id, {
      id: "comment-id",
      title: "Результат",
      body: "Запись журнала",
      createdAt: task.createdAt,
      createdBy: "writer",
    });
  } else {
    db.insertBatchReceipt(receipt);
  }
}

describe("Привязка публикации к текущим физическим строкам", () => {
  test.each([
    { name: "accept", replica: "first" },
    { name: "bootstrap", replica: "second" },
  ] as const)(
    "$name сохраняет current proof и canonical metadata один к одному",
    async ({ replica }) => {
      await withReplicationFixture(seedTask, (fixture) => {
        const db = fixture[replica];
        const captured = new ReplicationService(db).capture();
        const rows = snapshotToPortableRows(captured);
        const raw = new Database(db.path, { readonly: true, create: false });
        try {
          expect(captured).toEqual(fixture.remote);
          expect(captured.publication?.publicationId).toBe(
            fixture.remote.publication?.publicationId,
          );
          expect(captured.publication).not.toBeNull();
          expect(() => validatePublicationEnvelope(captured)).not.toThrow();
          expect(raw.query("SELECT * FROM replication_publications ORDER BY id").all()).toEqual([
            ...rows.tables.replication_publications,
          ]);
          expect(
            raw.query("SELECT * FROM replication_confirmations ORDER BY replica_id").all(),
          ).toEqual([...rows.tables.replication_confirmations]);
          expect(db.getReplicationOutbox()).toEqual([]);
        } finally {
          raw.close();
        }
      });
    },
  );

  test.each([
    { name: "содержание", kind: "owner" },
    { name: "комментарий", kind: "comment" },
    { name: "receipt-only", kind: "receipt" },
  ] as const)("$name снимает proof до flush, а savepoint восстанавливает его", async ({ kind }) => {
    await withReplicationFixture(seedTask, ({ first, remote }) => {
      const task = new TasksService(first).get("PRODUCT-1");
      const guard = first.getReplicationGuard();
      const failure = new Error("Откат проверяемого savepoint");

      first.transaction(() => {
        expect(() =>
          first.transaction(() => {
            mutateStoredTask(first, task, kind);
            expect(first.captureReplication().publication).toBeNull();
            expect(first.getReplicationState().base).toEqual(remote);
            throw failure;
          }),
        ).toThrow(failure);
        expect(new ReplicationService(first).capture()).toEqual(remote);
      });

      expect(first.getReplicationGuard()).toEqual(guard);
      expect(first.getReplicationOutbox()).toEqual([]);
      expect(first.getBatchReceipt(receipt.operationKey)).toBeUndefined();

      mutateStoredTask(first, task, kind);

      const captured = first.captureReplication();
      expect(captured.publication).toBeNull();
      expect(first.getReplicationState().base).toEqual(remote);
      expect(first.getReplicationOutbox()).toHaveLength(1);
      if (kind === "receipt") {
        expect(first.getGeneration()).toBe(guard.generation);
        expect(captured.receipts).toEqual([receipt]);
      } else if (kind === "comment") {
        expect(captured.comments[0]?.comment.body).toBe("Запись журнала");
        expect(first.get(task.id)?.revision).toBe(task.revision);
      } else {
        expect(first.get(task.id)?.data.description).toBe("Правка");
      }
    });
  });

  test("изменение критерия снимает proof, а его приёмка связывает новый снимок без echo", async () => {
    await withReplicationFixture(seedTask, async ({ first, second, remote }) => {
      const tasks = new TasksService(first);
      const task = tasks.get("PRODUCT-1");
      const sync = new ReplicationService(first);

      const updated = await tasks.criterion(
        task.id,
        "add",
        { title: "Проверить результат" },
        { actor: "writer", ifRevision: task.revision },
      );

      expect(updated.data.acceptanceCriteria[0]?.title).toBe("Проверить результат");
      expect(sync.capture().publication).toBeNull();
      expect(first.getReplicationState().base).toEqual(remote);
      const prepared = sync.prepare(remote);
      expect(prepared.conflicts).toEqual([]);
      sync.accept(prepared.snapshot);
      new ReplicationService(second).accept(prepared.snapshot);
      expect(new ReplicationService(second).capture()).toEqual(prepared.snapshot);
      expect(second.getReplicationOutbox()).toEqual([]);
    });
  });

  test("receipt-only команда инвалидирует proof без изменения владельца и поколения", async () => {
    await withReplicationFixture(seedTask, async ({ first, remote }) => {
      const task = new TasksService(first).get("PRODUCT-1");
      const generation = first.getGeneration();

      await new BatchService(first).execute(
        {
          version: 1,
          operations: [
            {
              op: "task.update",
              ref: task.id,
              ifRevision: task.revision,
              input: { title: task.data.title },
            },
          ],
        },
        { actor: "writer", operationKey: "noop-with-receipt" },
      );

      expect(first.captureReplication().publication).toBeNull();
      expect(first.get(task.id)).toEqual(task);
      expect(first.getGeneration()).toBe(generation);
      expect(first.getBatchReceipt("noop-with-receipt")).toBeDefined();
      expect(first.getReplicationOutbox()[0]?.entities).toEqual([]);
      expect(first.getReplicationState().base).toEqual(remote);
    });
  });

  test("no-op команды и повторный accept не переписывают publication и guards", async () => {
    await withReplicationFixture(seedTask, async ({ first, remote }) => {
      const tasks = new TasksService(first);
      const task = tasks.get("PRODUCT-1");
      const guard = first.getReplicationGuard();
      const anchor = await first.commands.load({ anchor: null, selectors: [] });
      const audit = new Database(first.path, { create: false, strict: true });
      try {
        audit.exec("CREATE TABLE publication_audit(event TEXT)");
        for (const event of ["INSERT", "UPDATE", "DELETE"]) {
          audit.exec(`CREATE TRIGGER publication_audit_${event} AFTER ${event} ON replication_publications
            BEGIN INSERT INTO publication_audit VALUES('${event}'); END;`);
        }

        await tasks.update(
          task.id,
          { title: task.data.title },
          { actor: "writer", ifRevision: task.revision },
        );
        first.updateReplicationState({ conflicts: [] });
        new ReplicationService(first).accept(remote);

        expect(audit.query("SELECT * FROM publication_audit").all()).toEqual([]);
        expect(first.getReplicationGuard()).toEqual(guard);
        expect((await first.commands.load({ anchor: null, selectors: [] })).anchor).toEqual(
          anchor.anchor,
        );
        expect(first.captureReplication().publication).toEqual(remote.publication);
        expect(first.getReplicationOutbox()).toEqual([]);
      } finally {
        audit.close();
      }
    });
  });

  test("явный null снимает только current proof и меняет guard, повтор является no-op", async () => {
    await withReplicationFixture(
      () => {},
      ({ first, remote }) => {
        const before = first.getReplicationGuard();

        first.updateReplicationState({ currentPublication: null, conflicts: [] });

        const cleared = first.getReplicationGuard();
        expect(cleared.revision).toBe(before.revision + 1);
        expect(cleared.generation).toBe(before.generation);
        expect(cleared.sequence).toBe(before.sequence);
        expect(first.captureReplication().publication).toBeNull();
        expect(first.getReplicationState().base).toEqual(remote);
        first.updateReplicationState({ currentPublication: null, conflicts: [] });
        expect(first.getReplicationGuard()).toEqual(cleared);
        first.updateReplicationState({
          currentPublication: remote.publication ?? null,
          conflicts: [],
        });
        expect(first.captureReplication().publication).toEqual(remote.publication);
        expect(first.getReplicationGuard().revision).toBe(cleared.revision + 1);
        expect(first.getReplicationOutbox()).toEqual([]);
      },
    );
  });

  test("новые confirmations снимают proof без неявной подстановки publication из base", async () => {
    await withReplicationFixture(seedTask, async ({ first, second, remote }) => {
      const task = new TasksService(second).get("PRODUCT-1");
      await new TasksService(second).comment(task.id, "Принято удалённо", "remote");
      const published = new ReplicationService(second).prepare(remote).snapshot;
      const before = first.getReplicationGuard();

      // Storage получает проверенный checkpoint для ledger, но предметный импорт здесь не запрошен.
      first.updateReplicationState({ base: published, conflicts: [] });

      const captured = first.captureReplication();
      expect(captured.publication).toBeNull();
      expect(captured.confirmations).toEqual(published.confirmations);
      expect(captured.comments).toEqual([]);
      expect(first.getReplicationState().base).toEqual(published);
      expect(first.getReplicationGuard().revision).toBeGreaterThan(before.revision);
      expect(first.getGeneration()).toBe(before.generation);
      expect(first.getReplicationOutbox()).toEqual([]);
    });
  });

  test("sparse receipt-only import снимает proof и меняет guard без echo и implicit binding", async () => {
    await withReplicationFixture(seedTask, async ({ first, second, remote }) => {
      const task = new TasksService(second).get("PRODUCT-1");
      await new BatchService(second).execute(
        {
          version: 1,
          operations: [
            {
              op: "task.update",
              ref: task.id,
              ifRevision: task.revision,
              input: { title: task.data.title },
            },
          ],
        },
        { actor: "remote", operationKey: "remote-receipt" },
      );
      const published = new ReplicationService(second).prepare(remote).snapshot;
      const guard = first.getReplicationGuard();

      first.importReplication(published);

      expect(first.captureReplication().publication).toBeNull();
      expect(first.getBatchReceipt("remote-receipt")).toEqual(
        second.getBatchReceipt("remote-receipt"),
      );
      expect(first.getGeneration()).toBe(guard.generation);
      expect(first.getReplicationGuard().revision).toBeGreaterThan(guard.revision);
      expect(first.getReplicationState().base).toEqual(remote);
      expect(first.getReplicationOutbox()).toEqual([]);
    });
  });

  test("поздняя запись остаётся pending без ложного proof старой публикации", async () => {
    await withReplicationFixture(seedTask, async ({ first, remote }) => {
      const tasks = new TasksService(first);
      const original = tasks.get("PRODUCT-1");
      const sync = new ReplicationService(first);
      const updated = await tasks.update(
        original.id,
        { title: "Первая правка" },
        { actor: "writer", ifRevision: original.revision },
      );
      const published = sync.prepare(remote).snapshot;
      await tasks.update(
        updated.id,
        { description: "Поздняя правка" },
        { actor: "writer", ifRevision: updated.revision },
      );
      const pending = first.getReplicationOutbox().at(-1);
      if (pending === undefined) {
        throw new Error("Поздняя команда должна оставаться в outbox");
      }

      const accepted = sync.accept(published);

      expect(accepted.reconciled).toBe(true);
      expect(first.getReplicationState().base).toEqual(published);
      expect(first.getReplicationOutbox()).toEqual([pending]);
      expect(sync.capture().publication).toBeNull();
      expect(tasks.get(original.id).data).toMatchObject({
        title: "Первая правка",
        description: "Поздняя правка",
      });
      const completed = sync.prepare(published);
      sync.accept(completed.snapshot);
      expect(sync.capture()).toEqual(completed.snapshot);
      expect(sync.status().pending).toBe(0);
    });
  });
});
