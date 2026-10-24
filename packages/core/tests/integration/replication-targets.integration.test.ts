import { describe, expect, test } from "bun:test";
import type { ReplicationTransition } from "@relay/contracts";
import { BatchService } from "../../src/batch/batch";
import { TasksService } from "../../src/tasks/tasks";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";
import {
  redigestSource,
  unverifiedSourcePublication,
} from "./helpers/replication-publication-fixture";

const corruptions = [
  { name: "отсутствующие targets", damage: "missing", code: "REPLICATION_FORMAT" },
  { name: "пустой ownerIds", damage: "empty-owners", code: "REPLICATION_FORMAT" },
  { name: "нулевой primaryId", damage: "null-primary", code: "REPLICATION_FORMAT" },
  { name: "отсутствующие roles", damage: "missing-roles", code: "REPLICATION_FORMAT" },
  { name: "пустые roles", damage: "empty-roles", code: "REPLICATION_FORMAT" },
  { name: "чужой ownerId", damage: "other-owner", code: "REPLICATION_FORMAT" },
  { name: "чужой primaryId", damage: "other-primary", code: "REPLICATION_FORMAT" },
  {
    name: "согласованная подмена целей на зависимость из graph read",
    damage: "other-targets",
    code: "REPLICATION_FORMAT",
  },
  {
    name: "отсутствующий content guard владельца",
    damage: "missing-guard",
    code: "REPLICATION_FORMAT",
  },
  {
    name: "подмена именованной команды на legacy.atomic",
    damage: "legacy",
    code: "REPLICATION_FORMAT",
  },
  {
    name: "техническая boundary вместо шага смешанного batch",
    damage: "technical",
    code: "REPLICATION_FORMAT",
  },
  { name: "полные targets", damage: "intact", code: "TASK_INCOMPLETE" },
] as const;

/**
 * Повреждает только доказательство цели первого no-op, сохраняя команду и эффекты второго шага.
 */
function corruptNoop(
  step: ReplicationTransition,
  damage: string,
  dependencyId: string,
): ReplicationTransition {
  const targets = step.targets;
  if (targets === undefined) {
    throw new Error("Нет targets исходной команды");
  }
  switch (damage) {
    case "missing": {
      const { targets: _targets, ...rest } = step;
      return rest;
    }
    case "empty-owners":
      return { ...step, targets: { ...targets, ownerIds: [] } };
    case "null-primary":
      return { ...step, targets: { ...targets, primaryId: null } };
    case "missing-roles": {
      const { roles: _roles, ...rest } = targets;
      return { ...step, targets: rest };
    }
    case "empty-roles":
      return { ...step, targets: { ...targets, roles: {} } };
    case "other-owner":
      return { ...step, targets: { ...targets, ownerIds: [dependencyId] } };
    case "other-primary":
      return { ...step, targets: { ...targets, primaryId: dependencyId } };
    case "other-targets":
      return {
        ...step,
        targets: {
          primaryId: dependencyId,
          ownerIds: [dependencyId],
          roles: { ref: dependencyId },
        },
      };
    case "missing-guard":
      return {
        ...step,
        readContext: step.readContext.filter((entry) => entry.id !== targets.primaryId),
      };
    case "legacy":
      return { ...step, command: "legacy.atomic" };
    case "technical":
      return { ...step, command: "storage.atomic" };
    case "intact":
      return step;
    default:
      throw new Error("Неизвестное повреждение targets");
  }
}

describe("Цели исходных именованных границ публикации", () => {
  test.each(corruptions)(
    "$name не обходят повторную проверку no-op done в смешанном batch",
    async ({ damage, code }) => {
      await withReplicationFixture(
        async (db) => {
          const tasks = new TasksService(db);
          const dependency = await tasks.create({ title: "Зависимость" }, "seed");
          await tasks.move(
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
        },
        async ({ first, second, remote }) => {
          const task = new TasksService(first).get("PRODUCT-2");
          await new BatchService(first).execute(
            {
              version: 1,
              operations: [
                {
                  op: "task.move",
                  ref: task.id,
                  ifRevision: task.revision,
                  input: { column: "done" },
                },
                {
                  op: "document.create",
                  input: { name: "Спутник no-op", body: "Только целый batch" },
                },
              ],
            },
            { actor: "author", operationKey: "mixed-noop" },
          );
          const source = first.getReplicationOutbox()[0];
          if (source === undefined || source.transitions === undefined) {
            throw new Error("Нет исходного batch");
          }
          expect(source.transitions[0]?.entities).toEqual([]);
          expect(source.transitions[0]?.components).toEqual([]);
          const peer = new ReplicationService(second);
          const dependency = new TasksService(second).get("PRODUCT-1");
          await new TasksService(second).move(
            dependency.id,
            { column: "ready" },
            { actor: "remote", ifRevision: dependency.revision },
          );
          const published = peer.prepare(remote).snapshot;
          peer.accept(published);
          const changed = redigestSource({
            ...source,
            transitions: source.transitions.map((step, index) =>
              index === 0 ? corruptNoop(step, damage, dependency.id) : step,
            ),
          });
          const incoming = unverifiedSourcePublication(published, changed);
          await new KnowledgeService(second).create(
            "feature",
            { name: "Неподтверждённая локальная" },
            "local",
          );
          const state = second.getReplicationState();
          const pending = second.getReplicationOutbox();
          const before = peer.capture();

          expect(() => peer.accept(incoming)).toThrow(expect.objectContaining({ code }));

          expect(peer.capture()).toEqual(before);
          expect(second.getReplicationState()).toEqual(state);
          expect(second.getReplicationOutbox()).toEqual(pending);
          expect(second.getBatchReceipt("mixed-noop")).toBeUndefined();
          expect(second.get("DOC-1")).toBeUndefined();
          expect(second.get(task.id)?.data.column).toBe("done");
          expect(second.get(dependency.id)?.data.column).toBe("ready");
        },
      );
    },
  );

  test("неполный набор владельцев transfer не импортирует ни сторону переноса, ни receipt", async () => {
    await withReplicationFixture(
      async (db) => {
        const task = await new TasksService(db).create({ title: "Переносимая" }, "seed");
        const plans = new PlanningService(db);
        for (const title of ["Источник", "Получатель"]) {
          const plan = await plans.create("work-plan", { title }, "seed");
          const staged = await plans.stage(
            plan.id,
            "create",
            { title: "Этап" },
            { actor: "seed", ifRevision: plan.revision },
          );
          if (title === "Источник") {
            const stage = staged.data.stages[0];
            if (stage === undefined) {
              throw new Error("Нет этапа источника");
            }
            await plans.stageTask(plan.id, stage.id, task.id, false, {
              actor: "seed",
              ifRevision: staged.revision,
            });
          }
        }
      },
      async ({ first, second, remote }) => {
        const plans = new PlanningService(first);
        const sourcePlan = plans.get("work-plan", "PLN-1");
        const targetPlan = plans.get("work-plan", "PLN-2");
        const targetStage = targetPlan.data.stages[0];
        if (targetStage === undefined) {
          throw new Error("Нет этапа получателя");
        }
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "plan.stage.task.transfer",
                ref: sourcePlan.id,
                ifRevision: sourcePlan.revision,
                input: {
                  task: "PRODUCT-1",
                  targetPlan: targetPlan.id,
                  targetStage: targetStage.id,
                  targetRevision: targetPlan.revision,
                  reason: "Перенос",
                },
              },
            ],
          },
          { actor: "author", operationKey: "transfer-owners" },
        );
        const source = first.getReplicationOutbox()[0];
        if (source === undefined || source.transitions === undefined) {
          throw new Error("Нет исходного переноса");
        }
        const good = new ReplicationService(first).prepare(remote);
        expect(good.conflicts).toEqual([]);
        const bad = redigestSource({
          ...source,
          transitions: source.transitions.map((step) => {
            if (step.targets === undefined) {
              throw new Error("Нет targets переноса");
            }
            return { ...step, targets: { ...step.targets, ownerIds: [sourcePlan.id] } };
          }),
        });
        const incoming = unverifiedSourcePublication(remote, bad);
        const peer = new ReplicationService(second);
        const before = peer.capture();
        const state = second.getReplicationState();
        const pending = second.getReplicationOutbox();

        expect(() => peer.accept(incoming)).toThrow(
          expect.objectContaining({
            code: "REPLICATION_FORMAT",
            details: { path: "transition.targets" },
          }),
        );

        expect(peer.capture()).toEqual(before);
        expect(second.getReplicationState()).toEqual(state);
        expect(second.getReplicationOutbox()).toEqual(pending);
        expect(second.getBatchReceipt("transfer-owners")).toBeUndefined();
        peer.accept(good.snapshot);
        expect(
          new PlanningService(second).get("work-plan", sourcePlan.id).data.stages[0]?.taskIds,
        ).toEqual([]);
        expect(
          new PlanningService(second).get("work-plan", targetPlan.id).data.stages[0]?.taskIds,
        ).toEqual([new TasksService(first).get("PRODUCT-1").id]);
      },
    );
  });
});
