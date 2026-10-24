import { describe, expect, test } from "bun:test";
import type { BatchResult, CommandSelector, TaskComment } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { TasksService } from "../../src/tasks/tasks";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

/**
 * Создаёт именованный append с заданными ID и часами через настоящий SQLite command port.
 * Здесь проверяется порядок репликации, поэтому значения выделены fixture до commit;
 * глобальные часы, SQL, исходные guards и захват переносимой ленты не подменяются.
 */
async function appendFixedComment(
  database: ProjectDatabase,
  taskId: string,
  comment: TaskComment,
): Promise<void> {
  const selector: CommandSelector = {
    kind: "entity",
    ref: taskId,
    entityKind: "task",
    semantic: "existence",
  };
  const loaded = await database.commands.load({ anchor: null, selectors: [selector] });
  const observation = loaded.observations[0];
  if (
    observation?.kind !== "records" ||
    observation.records.length !== 1 ||
    observation.records[0]?.id !== taskId
  ) {
    throw new Error("Нет задачи для детерминированного комментария fixture");
  }
  await database.commands.commit({
    projectId: database.projectId,
    replicaId: loaded.anchor.replicaId,
    actor: comment.createdBy,
    timestamp: comment.createdAt,
    check: false,
    guards: loaded.guards,
    transitions: [
      {
        index: 0,
        operation: "task.comment.add",
        actor: comment.createdBy,
        timestamp: comment.createdAt,
        targets: { primaryId: comment.id, ownerIds: [taskId], roles: { ref: taskId } },
        reads: observation.records,
        guards: loaded.guards,
        predicates: [{ selector, observation }],
        effects: [{ kind: "comment", taskId, comment }],
      },
    ],
    counters: [],
    receipt: null,
    commentTaskIds: [],
    freshTaskIds: [],
    /**
     * Fixture не запрашивает пользовательскую квитанцию или проекцию результата append.
     */
    finalize(): BatchResult {
      return { operationKey: null, status: "committed", replayed: false, items: [], entities: [] };
    },
  });
}

describe("Пользовательский порядок реплицированного журнала", () => {
  test("одинаковые часы не меняют причинный порядок, обе публичные выдачи сходятся после встречных append", async () => {
    const createdAt = "2026-10-24T01:00:00.000Z";
    await withReplicationFixture(
      async (db) => {
        const task = await new TasksService(db).create({ title: "Журнал" }, "seed");
        await appendFixedComment(db, task.id, {
          id: "root",
          title: "",
          body: "Общее начало",
          createdAt,
          createdBy: "seed",
        });
      },
      async ({ first, second, remote }) => {
        const task = new TasksService(first).get("PRODUCT-1");
        const a = new TasksService(first);
        const b = new TasksService(second);
        // Явные одинаковые timestamps задают fixture без подмены глобальных часов.
        await appendFixedComment(first, task.id, {
          id: "z-left",
          title: "",
          body: "Слева\r\nточно",
          createdAt,
          createdBy: "left",
        });
        await appendFixedComment(second, task.id, {
          id: "a-right",
          title: "",
          body: "Справа",
          createdAt,
          createdBy: "right",
        });
        expect(a.comments(task.id).map((entry) => entry.id)).toEqual(["root", "z-left"]);
        expect(b.comments(task.id).map((entry) => entry.id)).toEqual(["root", "a-right"]);
        const syncA = new ReplicationService(first);
        const syncB = new ReplicationService(second);
        const acceptedRight = syncB.prepare(remote).snapshot;
        syncB.accept(acceptedRight);

        const merged = syncA.prepare(acceptedRight).snapshot;
        syncA.accept(merged);
        syncB.accept(merged);

        expect(a.comments(task.id).map((entry) => entry.id)).toEqual(["root", "a-right", "z-left"]);
        expect(a.comments(task.id)).toEqual(b.comments(task.id));
        expect(a.comments(task.id).map((entry) => entry.createdAt)).toEqual([
          createdAt,
          createdAt,
          createdAt,
        ]);
        expect(a.comments(task.id)[2]).toMatchObject({ body: "Слева\r\nточно", createdBy: "left" });

        await appendFixedComment(first, task.id, {
          id: "0-appended-last",
          title: "",
          body: "После объединения",
          createdAt,
          createdBy: "later",
        });
        const final = syncA.prepare(merged).snapshot;
        syncA.accept(final);
        syncB.accept(final);

        expect(a.comments(task.id).map((entry) => entry.id)).toEqual([
          "root",
          "a-right",
          "z-left",
          "0-appended-last",
        ]);
        expect(a.comments(task.id)).toEqual(b.comments(task.id));
        expect(a.get(task.id).revision).toBe(task.revision);
        expect(b.get(task.id).revision).toBe(task.revision);
      },
    );
  });
});
