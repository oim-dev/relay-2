import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TaskRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { TasksService } from "../../src/tasks/tasks";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

const receipt = {
  operationKey: "unflushed-receipt",
  requestJson: '{ "actor": "writer", "body": "\\ud800" }\n',
  resultJson: '{ "revision": 77 }\n',
};
const criterion = {
  id: "unflushed-criterion",
  title: "Не потерять незавершённый критерий",
  summary: "",
  description: "",
  completed: false,
  completedAt: null,
  completedBy: null,
};
const unflushedError = { code: "REPLICATION_UNFLUSHED_CHANGES", exitCode: 4 };

/**
 * Создаёт только задачу; общий fixture принимает исходный снимок и закрывает обе реплики.
 */
async function seedTask(db: ProjectDatabase): Promise<void> {
  await new TasksService(db).create({ title: "Исходная задача" }, "seed");
}

/**
 * Добавляет синхронную Storage-дельту под внешней transaction теста без её завершения.
 * Component-only сохраняет скаляры и updatedAt, чтобы переносимая версия owner ещё не менялась.
 * Техническая квитанция проверяет сохранность её точных строк, а не публикацию raw storage.atomic.
 */
function writeUnflushedChange(
  db: ProjectDatabase,
  task: TaskRecord,
  kind: "receipt" | "owner" | "component",
): void {
  if (kind === "receipt") {
    db.insertBatchReceipt(receipt);
    return;
  }
  const data =
    kind === "owner"
      ? { ...task.data, description: "Незавершённая правка" }
      : { ...task.data, acceptanceCriteria: [criterion] };
  db.update({ ...task, revision: task.revision + 1, data }, task.revision);
}

describe("Обмен поверх незавершённого SQL capture", () => {
  test.each([
    { name: "receipt-only", kind: "receipt" },
    { name: "owner scalar", kind: "owner" },
    { name: "component-only", kind: "component" },
  ] as const)("$name отклоняет accept до эффектов и сохраняет pending данные", async ({ kind }) => {
    await withReplicationFixture(seedTask, ({ first, remote }) => {
      const task = new TasksService(first).get("PRODUCT-1");
      const sync = new ReplicationService(first);
      const state = first.getReplicationState();
      expect(first.hasUnflushedReplicationChanges()).toBe(false);

      first.transaction(() => {
        writeUnflushedChange(first, task, kind);
        const captured = sync.capture();
        const guard = first.getReplicationGuard();
        expect(captured.publication).toBeNull();
        expect(first.getReplicationOutbox()).toEqual([]);
        expect(first.hasUnflushedReplicationChanges()).toBe(true);
        if (kind === "component") {
          expect(captured.entities.find((entry) => entry.record.id === task.id)?.version).toBe(
            remote.entities.find((entry) => entry.record.id === task.id)?.version,
          );
        }

        expect(() => sync.accept(remote)).toThrow(expect.objectContaining(unflushedError));

        expect(sync.capture()).toEqual(captured);
        expect(first.getReplicationGuard()).toEqual(guard);
        expect(first.getReplicationState()).toEqual(state);
        expect(first.getReplicationOutbox()).toEqual([]);
        expect(first.hasUnflushedReplicationChanges()).toBe(true);
      });

      expect(first.hasUnflushedReplicationChanges()).toBe(false);
      expect(sync.capture().publication).toBeNull();
      expect(first.getReplicationState().base).toEqual(remote);
      const outbox = first.getReplicationOutbox();
      expect(outbox).toHaveLength(1);
      if (kind === "receipt") {
        expect(first.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
        expect(outbox[0]?.receipts).toEqual([receipt]);
      } else if (kind === "owner") {
        expect(first.get(task.id)?.data.description).toBe("Незавершённая правка");
        expect(
          outbox[0]?.entities.find((entry) => entry.id === task.id)?.after?.record.data.description,
        ).toBe("Незавершённая правка");
      } else {
        expect(new TasksService(first).get(task.id).data.acceptanceCriteria).toEqual([criterion]);
        expect(
          outbox[0]?.components?.find((entry) => entry.after.kind === "task-criterion")?.after
            .value,
        ).toEqual(criterion);
      }
    });
  });

  test.each(["prepare", "resolve", "resolveKeys"] as const)(
    "%s отклоняется до записи transport-state при несброшенной квитанции",
    async (operation) => {
      await withReplicationFixture(
        () => {},
        ({ first, remote }) => {
          const sync = new ReplicationService(first);
          const state = first.getReplicationState();
          first.transaction(() => {
            first.insertBatchReceipt(receipt);
            const captured = sync.capture();
            const guard = first.getReplicationGuard();

            expect(() => {
              if (operation === "prepare") {
                sync.prepare(remote);
              } else if (operation === "resolve") {
                // Форма решения валидна; pending guard обязан предшествовать поиску конфликта.
                sync.resolve(
                  "unknown-source",
                  { choice: "remote", fingerprint: "a".repeat(64) },
                  "writer",
                );
              } else {
                sync.resolveKeys(
                  "unknown-source",
                  {
                    fingerprint: "a".repeat(64),
                    assignments: [{ entityId: first.projectId, key: "PROJECT-NEXT" }],
                  },
                  "writer",
                );
              }
            }).toThrow(expect.objectContaining(unflushedError));

            expect(first.getReplicationState()).toEqual(state);
            expect(first.getReplicationGuard()).toEqual(guard);
            expect(sync.capture()).toEqual(captured);
            expect(first.getReplicationOutbox()).toEqual([]);
          });
          expect(first.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
          expect(first.getReplicationOutbox()[0]?.receipts).toEqual([receipt]);
        },
      );
    },
  );

  test("bootstrap не стирает незавершённую мутацию пустой реплики", async () => {
    await withReplicationFixture(
      () => {},
      ({ first, remote, directory }) => {
        const replica = ProjectDatabase.createReplica(
          join(directory, "pending-bootstrap.sqlite"),
          first.projectId,
        );
        try {
          const sync = new ReplicationService(replica);
          replica.transaction(() => {
            replica.insertBatchReceipt(receipt);
            const captured = sync.capture();
            const state = replica.getReplicationState();
            const guard = replica.getReplicationGuard();

            expect(() => sync.bootstrap(remote)).toThrow(expect.objectContaining(unflushedError));

            expect(sync.capture()).toEqual(captured);
            expect(replica.getReplicationState()).toEqual(state);
            expect(replica.getReplicationGuard()).toEqual(guard);
            expect(replica.getReplicationOutbox()).toEqual([]);
          });
          expect(replica.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
          expect(replica.getReplicationOutbox()[0]?.receipts).toEqual([receipt]);
        } finally {
          replica.close();
        }
      },
    );
  });

  test("rollback очищает pending guard, а readonly и no-op внутри transaction разрешают обмен", async () => {
    await withReplicationFixture(seedTask, ({ first, remote }) => {
      const task = new TasksService(first).get("PRODUCT-1");
      const sync = new ReplicationService(first);
      const guard = first.getReplicationGuard();
      const failure = new Error("Откат локального изменения");

      first.transaction(() => {
        expect(() =>
          first.transaction(() => {
            first.insertBatchReceipt(receipt);
            expect(first.hasUnflushedReplicationChanges()).toBe(true);
            throw failure;
          }),
        ).toThrow(failure);
        // Эти чтения создают лишь observation queue; rename с прежним ключом не является мутацией.
        expect(first.get(task.id)).toEqual(task);
        expect(first.rename(task.id, task.key, task.revision, "writer")).toEqual(task);
        expect(first.hasUnflushedReplicationChanges()).toBe(false);
        expect(sync.prepare(remote).snapshot).toEqual(remote);
        expect(sync.accept(remote).reconciled).toBe(true);
      });

      expect(first.hasUnflushedReplicationChanges()).toBe(false);
      expect(first.getReplicationGuard()).toEqual(guard);
      expect(first.getReplicationOutbox()).toEqual([]);
      expect(first.getBatchReceipt(receipt.operationKey)).toBeUndefined();
      expect(sync.capture()).toEqual(remote);
    });
  });
});
