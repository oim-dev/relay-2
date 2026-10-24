import { describe, expect, test } from "bun:test";
import { TasksService } from "../../src/tasks/tasks";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

describe("Объединение предметных составов", () => {
  test("правка критерия, снятие другого и добавление третьего сохраняют ID и порядок", async () => {
    await withReplicationFixture(
      async (db) => {
        await new TasksService(db).create(
          { title: "Критерии", acceptanceCriteria: [{ title: "Первый" }, { title: "Второй" }] },
          "seed",
        );
      },
      async ({ first, second, remote }) => {
        const a = new TasksService(first);
        const b = new TasksService(second);
        const original = a.get("PRODUCT-1");
        const one = original.data.acceptanceCriteria[0];
        const two = original.data.acceptanceCriteria[1];
        if (one === undefined || two === undefined) {
          throw new Error("Нет исходных критериев");
        }
        await a.criterion(
          original.id,
          "update",
          { id: one.id, title: "Новый первый" },
          { actor: "left", ifRevision: original.revision },
        );
        const removed = await b.criterion(
          original.id,
          "remove",
          { id: two.id },
          { actor: "right", ifRevision: original.revision },
        );
        const added = await b.criterion(
          original.id,
          "add",
          { title: "Третий" },
          { actor: "right", ifRevision: removed.revision },
        );
        const third = added.data.acceptanceCriteria[1];
        if (third === undefined) {
          throw new Error("Третий критерий не создан");
        }
        const published = new ReplicationService(second).prepare(remote).snapshot;

        const candidate = new ReplicationService(first).prepare(published);

        expect(candidate.conflicts).toEqual([]);
        new ReplicationService(first).accept(candidate.snapshot);
        const criteria = a.get(original.id).data.acceptanceCriteria;
        expect(criteria.map((entry) => entry.title)).toEqual(["Новый первый", "Третий"]);
        expect(criteria.map((entry) => entry.id)).toEqual([one.id, third.id]);
      },
    );
  });

  test("отметка выполнения не переносится на конкурентно изменённый текст критерия", async () => {
    await withReplicationFixture(
      async (db) => {
        await new TasksService(db).create(
          { title: "Проверка", acceptanceCriteria: [{ title: "Старый текст" }] },
          "seed",
        );
      },
      async ({ first, second, remote }) => {
        const a = new TasksService(first);
        const b = new TasksService(second);
        const task = a.get("PRODUCT-1");
        const criterion = task.data.acceptanceCriteria[0];
        if (criterion === undefined) {
          throw new Error("Нет критерия");
        }
        await a.criterion(
          task.id,
          "update",
          { id: criterion.id, title: "Новая обязанность" },
          { actor: "left", ifRevision: task.revision },
        );
        await b.criterion(
          task.id,
          "complete",
          { id: criterion.id },
          { actor: "right", ifRevision: task.revision },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;

        const candidate = new ReplicationService(first).prepare(published);

        expect(candidate.conflicts[0]?.code).toBe("REPLICATION_CONFLICT");
        expect(candidate.included).toEqual([]);
        expect(a.get(task.id).data.acceptanceCriteria[0]).toMatchObject({
          title: "Новая обязанность",
          completed: false,
        });
      },
    );
  });

  test("перестановка этапов сочетается с правкой содержания другого этапа", async () => {
    await withReplicationFixture(
      async (db) => {
        const plans = new PlanningService(db);
        const initial = await plans.create("work-plan", { title: "План" }, "seed");
        const firstStage = await plans.stage(
          initial.id,
          "create",
          { title: "Первый" },
          { actor: "seed", ifRevision: initial.revision },
        );
        await plans.stage(
          initial.id,
          "create",
          { title: "Второй" },
          { actor: "seed", ifRevision: firstStage.revision },
        );
      },
      async ({ first, second, remote }) => {
        const a = new PlanningService(first);
        const b = new PlanningService(second);
        const plan = a.get("work-plan", "PLN-1");
        const one = plan.data.stages[0];
        const two = plan.data.stages[1];
        if (one === undefined || two === undefined) {
          throw new Error("Нет этапов");
        }
        await a.stage(
          plan.id,
          "move",
          { stageId: two.id, before: one.id },
          { actor: "left", ifRevision: plan.revision },
        );
        await b.stage(
          plan.id,
          "update",
          { stageId: one.id, title: "Уточнённый" },
          { actor: "right", ifRevision: b.get("work-plan", plan.id).revision },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;

        const candidate = new ReplicationService(first).prepare(published);

        expect(candidate.conflicts).toEqual([]);
        new ReplicationService(first).accept(candidate.snapshot);
        expect(
          a.get("work-plan", plan.id).data.stages.map((entry) => [entry.id, entry.title]),
        ).toEqual([
          [two.id, "Второй"],
          [one.id, "Уточнённый"],
        ]);
      },
    );
  });

  test("снятие FI не может оставить конкурентно добавленную активную SI без её владельца", async () => {
    await withReplicationFixture(
      async (db) => {
        const knowledge = new KnowledgeService(db);
        const feature = await knowledge.create("feature", { name: "Фича" }, "seed");
        await knowledge.create("scenario", { name: "Сценарий", feature: feature.id }, "seed");
        const application = await knowledge.create(
          "application",
          { name: "Web", slug: "web", prefix: "WEB" },
          "seed",
        );
        await knowledge.replaceParticipation(application.id, [feature.id], {
          actor: "seed",
          ifRevision: application.revision,
        });
      },
      async ({ first, second, remote }) => {
        const a = new KnowledgeService(first);
        const b = new KnowledgeService(second);
        const application = a.list("application")[0];
        const scenario = a.list("scenario")[0];
        const feature = a.list("feature")[0];
        if (application === undefined || scenario === undefined || feature === undefined) {
          throw new Error("Нет исходного состава");
        }
        await a.replaceParticipation(application.id, [], {
          actor: "left",
          ifRevision: application.revision,
        });
        await b.replaceParticipation(application.id, [feature.id, scenario.id], {
          actor: "right",
          ifRevision: b.get("application", application.id).revision,
        });
        expect(first.getReplicationOutbox()[0]?.entities).toHaveLength(2);
        const published = new ReplicationService(second).prepare(remote).snapshot;

        const candidate = new ReplicationService(first).prepare(published);

        expect(candidate.conflicts[0]?.code).toBe("REPLICATION_INVARIANT");
        expect(candidate.included).toEqual([]);
        expect(candidate.snapshot).toEqual(published);
      },
    );
  });
});
