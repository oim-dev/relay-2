import { describe, expect, test } from "bun:test";
import { portableEntity } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import { PlanningService } from "../../src/planning/planning";
import { HistoryService } from "../../src/history/history";
import { BatchService } from "../../src/batch/batch";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

describe("Инварианты согласования переносимого состояния", () => {
  test("raw snapshot сохраняет снятый sectionId и точный Markdown вместо effective-проекции", async () => {
    await withReplicationFixture(
      async (db) => {
        const knowledge = new KnowledgeService(db);
        const project = knowledge.get("project", "PROJECT");
        const section = await knowledge.changeSection(
          "create",
          { id: "retired", name: "Архив" },
          { actor: "seed", ifRevision: project.revision },
        );
        await knowledge.create(
          "document",
          { name: "Исторический", body: "\r\n# Точно  \r\n", sectionId: "retired" },
          "seed",
        );
        await knowledge.changeSection(
          "remove",
          { id: "retired" },
          { actor: "seed", ifRevision: section.revision },
        );
      },
      ({ first, second, remote }) => {
        expect(new KnowledgeService(first).get("document", "DOC-1").data.sectionId).toBeNull();
        expect(
          remote.entities.find((entry) => entry.record.key === "DOC-1")?.record.data,
        ).toMatchObject({ sectionId: "retired", body: "\r\n# Точно  \r\n" });
        expect(second.get("DOC-1")?.data.sectionId).toBe("retired");
        expect(new ReplicationService(second).prepare(remote).snapshot).toEqual(remote);
      },
    );
  });

  test("комбинация независимых связей не может создать цикл задач", async () => {
    await withReplicationFixture(
      async (db) => {
        const tasks = new TasksService(db);
        await tasks.create({ title: "A" }, "seed");
        await tasks.create({ title: "B" }, "seed");
      },
      async ({ first, second, remote }) => {
        const a = new TasksService(first);
        const b = new TasksService(second);
        await a.dependency("PRODUCT-1", "PRODUCT-2", false, { actor: "left", ifRevision: 1 });
        await b.dependency("PRODUCT-2", "PRODUCT-1", false, { actor: "right", ifRevision: 1 });
        const published = new ReplicationService(second).prepare(remote).snapshot;

        const prepared = new ReplicationService(first).prepare(published);

        expect(prepared.included).toEqual([]);
        expect(prepared.conflicts).toHaveLength(1);
        expect(prepared.conflicts[0]?.code).toBe("TASK_CYCLE");
        expect(prepared.snapshot).toEqual(published);
        expect(a.get("PRODUCT-1").data.dependencies).toEqual([a.get("PRODUCT-2").id]);
      },
    );
  });

  test("историческая done-задача с вновь открытой зависимостью остаётся переносимой", async () => {
    await withReplicationFixture(
      async (db) => {
        const tasks = new TasksService(db);
        const dependency = await tasks.create({ title: "Зависимость" }, "seed");
        const doneDependency = await tasks.move(
          dependency.id,
          { column: "done" },
          { actor: "seed", ifRevision: dependency.revision },
        );
        const task = await tasks.create({ title: "Завершённая" }, "seed");
        const linked = await tasks.dependency(task.id, dependency.id, false, {
          actor: "seed",
          ifRevision: task.revision,
        });
        await tasks.move(
          task.id,
          { column: "done" },
          { actor: "seed", ifRevision: linked.revision },
        );
        await tasks.move(
          dependency.id,
          { column: "ready" },
          { actor: "seed", ifRevision: doneDependency.revision },
        );
      },
      async ({ first, second, remote }) => {
        expect(new TasksService(second).get("PRODUCT-2").data.column).toBe("done");
        await new KnowledgeService(first).create(
          "document",
          { name: "Независимый", body: "Старую историю не переисполняем" },
          "left",
        );

        const prepared = new ReplicationService(first).prepare(remote);

        expect(prepared.conflicts).toEqual([]);
        new ReplicationService(second).accept(prepared.snapshot);
        expect(second.get("DOC-1")?.data.name).toBe("Независимый");
      },
    );
  });

  test("параллельные включения одной задачи в разные открытые планы конфликтуют", async () => {
    await withReplicationFixture(
      async (db) => {
        await new TasksService(db).create({ title: "Общая задача" }, "seed");
        const plans = new PlanningService(db);
        for (const title of ["A", "B"]) {
          const plan = await plans.create("work-plan", { title }, "seed");
          await plans.stage(
            plan.id,
            "create",
            { title: "Этап" },
            { actor: "seed", ifRevision: plan.revision },
          );
        }
      },
      async ({ first, second, remote }) => {
        const a = new PlanningService(first);
        const b = new PlanningService(second);
        const left = a.get("work-plan", "PLN-1");
        const right = b.get("work-plan", "PLN-2");
        const stageA = left.data.stages[0];
        const stageB = right.data.stages[0];
        if (stageA === undefined || stageB === undefined) {
          throw new Error("Нет исходных этапов");
        }
        await a.stageTask(left.id, stageA.id, "PRODUCT-1", false, {
          actor: "left",
          ifRevision: left.revision,
        });
        await b.stageTask(right.id, stageB.id, "PRODUCT-1", false, {
          actor: "right",
          ifRevision: right.revision,
        });
        const published = new ReplicationService(second).prepare(remote).snapshot;

        const prepared = new ReplicationService(first).prepare(published);

        expect(prepared.conflicts[0]?.code).toBe("MEMBERSHIP_CONFLICT");
        expect(prepared.included).toEqual([]);
      },
    );
  });

  test("checkpoint старого владельца не принимается поверх takeover", async () => {
    await withReplicationFixture(
      async (db) => {
        await new HistoryService(db).start({ title: "Работа" }, "owner");
      },
      async ({ first, second, remote }) => {
        const historyA = new HistoryService(first);
        const historyB = new HistoryService(second);
        const session = historyA.list({})[0];
        if (session === undefined || session.data.currentRunId === null) {
          throw new Error("Нет владельца сессии");
        }
        const checkpoint = await historyA.checkpoint(
          session.id,
          "open",
          {
            runId: session.data.currentRunId,
            title: "Намерение",
            body: "Запись старого владельца",
          },
          { actor: "owner", ifRevision: session.revision },
        );
        await historyB.transition(
          session.id,
          "takeover",
          { reason: "Принятое владение" },
          { actor: "new-owner", ifRevision: session.revision },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;

        const prepared = new ReplicationService(first).prepare(published);

        expect(prepared.conflicts).toHaveLength(1);
        expect(prepared.snapshot.entities.some((entry) => entry.record.id === checkpoint.id)).toBe(
          false,
        );
        expect(first.get(checkpoint.id)?.revision).toBe(1);
      },
    );
  });

  test("перенумерация цели сохраняет checkpoint revision=1, sessionRevision и historical key snapshots", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const a = new HistoryService(first);
        const b = new HistoryService(second);
        const document = await new KnowledgeService(first).create(
          "document",
          { name: "Локальный", body: "Снимок" },
          "left",
        );
        await new KnowledgeService(second).create(
          "document",
          { name: "Удалённый", body: "Занял адрес" },
          "right",
        );
        const left = await a.start({ title: "Слева" }, "left");
        const right = await b.start({ title: "Справа" }, "right");
        const checkpoint = await a.checkpoint(
          left.id,
          "open",
          {
            runId: left.data.currentRunId,
            title: "Исходный",
            body: "Точное содержимое",
            references: [document.id],
          },
          { actor: "left", ifRevision: left.revision },
        );
        await b.checkpoint(
          right.id,
          "open",
          { runId: right.data.currentRunId, title: "Remote", body: "Принятый" },
          { actor: "right", ifRevision: right.revision },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const service = new ReplicationService(first);

        const candidate = service.prepare(published);
        service.accept(candidate.snapshot);

        expect(candidate.conflicts).toEqual([]);
        const imported = a.getCheckpoint(checkpoint.id);
        expect(imported.revision).toBe(1);
        expect(imported.key).toBe(checkpoint.key);
        expect(imported.data).toEqual(checkpoint.data);
        expect(imported.data.references[0]?.key).toBe(document.key);
        expect(first.get(document.id)?.key).not.toBe(document.key);
      },
    );
  });

  test("закрытый опубликованный checkpoint нельзя переписать даже в структурно валидном remote", async () => {
    await withReplicationFixture(
      async (db) => {
        const history = new HistoryService(db);
        const session = await history.start({ title: "Работа" }, "owner");
        await history.checkpoint(
          session.id,
          "open",
          { runId: session.data.currentRunId, title: "Первый", body: "История" },
          { actor: "owner", ifRevision: session.revision },
        );
      },
      ({ first, remote }) => {
        const damaged = {
          ...remote,
          entities: remote.entities.map((entry) =>
            entry.record.kind === "work-checkpoint"
              ? portableEntity({ ...entry.record, data: { ...entry.record.data, body: "Подмена" } })
              : entry,
          ),
        };
        const before = first.captureReplication();

        expect(() => new ReplicationService(first).accept(damaged)).toThrow(
          expect.objectContaining({ code: "REPLICATION_IMMUTABLE" }),
        );

        expect(first.captureReplication()).toEqual(before);
      },
    );
  });

  test("remote-решение конфликтного batch не публикует ни одну его запись, receipt остаётся первоначальной", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("feature", { name: "Основа" }, "seed");
      },
      async ({ first, second, remote }) => {
        const batch = new BatchService(first);
        const result = await batch.execute(
          {
            version: 1,
            operations: [
              {
                op: "feature.update",
                ref: "FEATURE-1",
                ifRevision: 1,
                input: { name: "Локальная правка" },
              },
              {
                op: "document.create",
                input: { name: "Атомарный ребёнок", body: "Только с первым шагом" },
              },
            ],
          },
          { actor: "left", operationKey: "atomic-conflict" },
        );
        await new KnowledgeService(second).update(
          "feature",
          "FEATURE-1",
          { name: "Принято" },
          { actor: "right", ifRevision: 1 },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const service = new ReplicationService(first);
        const conflict = service.prepare(published).conflicts[0];
        if (conflict === undefined) {
          throw new Error("Нет ожидаемого конфликта");
        }

        const resolved = service.resolve(
          conflict.id,
          { fingerprint: conflict.fingerprint, choice: "remote" },
          "resolver",
        );
        expect(service.status().pending).toBe(1);
        service.accept(resolved.snapshot);

        expect(resolved.conflicts).toEqual([]);
        expect(first.get("DOC-1")).toBeUndefined();
        expect(first.get("FEATURE-1")?.data.name).toBe("Принято");
        expect(batch.getResult("atomic-conflict")).toEqual({ ...result, replayed: true });
        expect(service.status().pending).toBe(0);
      },
    );
  });
});
