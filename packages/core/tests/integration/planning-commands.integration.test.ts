import { describe, expect, spyOn, test } from "bun:test";
import type { CommandStore, WorkPlanRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { CommandExecutor } from "../../src/batch/batch";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import { TaskGraphCache } from "../../src/tasks/task-command-graph";
import {
  entityWriteOptions as write,
  expectAsyncRelayError,
  withEntityDatabase,
} from "./helpers/entity-fixture";
import type { PlanningObservedGraph } from "./helpers/planning-fixture.types";

const actor = "planning-command";

/**
 * Создаёт только открытый план с одним пустым этапом через настоящий async путь.
 */
async function emptyPlan(service: PlanningService, title: string): Promise<WorkPlanRecord> {
  const plan = await service.create("work-plan", { title, goal: "Проверить атомарность" }, actor);
  return service.stage(plan.id, "create", { title: "Этап" }, write(plan, actor));
}

/**
 * Возвращает единственный этап fixture; отсутствие не превращается в пустой ID.
 */
function stageId(plan: WorkPlanRecord): string {
  const stage = plan.data.stages[0];
  if (stage === undefined) {
    throw new Error("Для проверки нужен этап");
  }
  return stage.id;
}

describe("Async planning через точный guarded commit", () => {
  test("version-only transfer проверяет aggregateVersion обоих владельцев без числовых ревизий", async () => {
    await withEntityDatabase(async (db) => {
      const service = new PlanningService(db);
      const tasks = new TasksService(db);
      const task = await tasks.create({ title: "Перенос по версиям" }, actor);
      let source = await emptyPlan(service, "Источник");
      source = await service.stageTask(
        source.id,
        stageId(source),
        task.id,
        false,
        write(source, actor),
      );
      const target = await emptyPlan(service, "Получатель");
      const executor = new CommandExecutor(db.commands);
      const sourceView = await executor.readVersioned(source.id, "work-plan");
      const targetView = await executor.readVersioned(target.id, "work-plan");
      const outboxSize = db.getReplicationOutbox().length;

      const result = await executor.execute(
        {
          op: "plan.stage.task.transfer",
          ref: source.id,
          expectedVersion: sourceView.versions.aggregateVersion,
          input: {
            task: task.id,
            targetPlan: target.id,
            targetStage: stageId(target),
            reason: "Перенос по прочитанным версиям обоих планов",
            targetVersion: targetView.versions.aggregateVersion,
          },
        },
        { actor },
      );

      const savedSource = service.get("work-plan", source.id);
      const savedTarget = service.get("work-plan", target.id);
      expect(savedSource.data.stages[0]?.taskIds).toEqual([]);
      expect(savedTarget.data.stages[0]?.taskIds).toEqual([task.id]);
      expect(savedSource.revision).toBe(source.revision + 1);
      expect(savedTarget.revision).toBe(target.revision + 1);
      expect(result.items[0]?.owner).toMatchObject({
        id: source.id,
        revision: savedSource.revision,
      });
      expect(result.items[0]?.outputs).toContainEqual({
        name: "target",
        id: target.id,
        key: target.key,
        kind: "work-plan",
        revision: savedTarget.revision,
      });
      expect(tasks.get(task.id)).toEqual(task);
      expect(db.getReplicationOutbox()).toHaveLength(outboxSize + 1);
    });
  });

  test("устаревший targetVersion transfer отклоняется несмотря на актуальный targetRevision без частичной записи", async () => {
    await withEntityDatabase(async (db) => {
      const service = new PlanningService(db);
      const tasks = new TasksService(db);
      const task = await tasks.create({ title: "Не переносить по устаревшему токену" }, actor);
      let source = await emptyPlan(service, "Источник");
      source = await service.stageTask(
        source.id,
        stageId(source),
        task.id,
        false,
        write(source, actor),
      );
      const target = await emptyPlan(service, "Получатель");
      const executor = new CommandExecutor(db.commands);
      const sourceView = await executor.readVersioned(source.id, "work-plan");
      const oldTargetView = await executor.readVersioned(target.id, "work-plan");
      const changedTarget = await service.stage(
        target.id,
        "update",
        { stageId: stageId(target), summary: "Новые условия вложенного этапа" },
        write(target, actor),
      );
      const currentTargetView = await executor.readVersioned(target.id, "work-plan");
      const generation = db.getGeneration();
      const outbox = db.getReplicationOutbox();

      const failure = await expectAsyncRelayError(
        () =>
          executor.execute(
            {
              op: "plan.stage.task.transfer",
              ref: source.id,
              expectedVersion: sourceView.versions.aggregateVersion,
              input: {
                task: task.id,
                targetPlan: target.id,
                targetStage: stageId(target),
                reason: "Устаревшее основание",
                targetRevision: changedTarget.revision,
                targetVersion: oldTargetView.versions.aggregateVersion,
              },
            },
            { actor, operationKey: "stale-target-version" },
          ),
        "VERSION_CONFLICT",
      );

      expect(currentTargetView.versions.aggregateVersion).not.toBe(
        oldTargetView.versions.aggregateVersion,
      );
      expect(failure.details).toMatchObject({
        id: target.id,
        expectedVersion: oldTargetView.versions.aggregateVersion,
        actualVersion: currentTargetView.versions.aggregateVersion,
        path: "operations[0].input.targetVersion",
      });
      expect(service.get("work-plan", source.id)).toEqual(source);
      expect(service.get("work-plan", target.id)).toEqual(changedTarget);
      expect(tasks.get(task.id)).toEqual(task);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(outbox);
      expect(db.getBatchReceipt("stale-target-version")).toBeUndefined();
    });
  });

  test("пустая выборка включений защищена от конкурентного включения в другой план", async () => {
    await withEntityDatabase(async (db) => {
      const service = new PlanningService(db);
      const task = await new TasksService(db).create({ title: "Общая задача" }, actor);
      const first = await emptyPlan(service, "Первый");
      const second = await emptyPlan(service, "Второй");
      const writer = ProjectDatabase.open(db.path);
      let commits = 0;
      let winner: WorkPlanRecord | undefined;
      let winnerOutbox = 0;
      const store: CommandStore = {
        projectId: db.projectId,
        /**
         * Реальная SQLite выборка завершается после async границы.
         */
        async load(request) {
          await Promise.resolve();
          return db.commands.load(request);
        },
        /**
         * Второй writer публикует включение после последнего load первого, перед его commit.
         */
        async commit(plan) {
          commits++;
          const membership = plan.transitions
            .flatMap((step) => step.predicates)
            .find((predicate) => predicate.selector.kind === "memberships");
          expect(membership?.observation).toEqual({ kind: "records", records: [] });
          winner = await new PlanningService(writer).stageTask(
            second.id,
            stageId(second),
            task.id,
            false,
            write(second, actor),
          );
          winnerOutbox = writer.getReplicationOutbox().length;
          return db.commands.commit(plan);
        },
      };
      try {
        await expectAsyncRelayError(
          () =>
            new CommandExecutor(store).execute(
              {
                op: "plan.stage.task.add",
                ref: first.id,
                ifRevision: first.revision,
                input: { stageId: stageId(first), task: task.id },
              },
              { actor, operationKey: "membership-race" },
            ),
          "COMMAND_CONTEXT_CHANGED",
        );

        expect(commits).toBe(1);
        if (winner === undefined) {
          throw new Error("Конкурентный writer не сохранил включение");
        }
        expect(service.get("work-plan", first.id)).toEqual(first);
        expect(service.get("work-plan", second.id)).toEqual(winner);
        expect(service.memberships(task.id).items.map((item) => item.plan)).toEqual([second.key]);
        expect(db.getBatchReceipt("membership-race")).toBeUndefined();
        expect(db.getReplicationOutbox()).toHaveLength(winnerOutbox);
      } finally {
        writer.close();
      }
    });
  });

  test("конкурентное переоткрытие задачи отклоняет рассчитанный complete без смены CAS и частичной записи", async () => {
    await withEntityDatabase(async (db) => {
      const service = new PlanningService(db);
      const tasks = new TasksService(db);
      const task = await tasks.create({ title: "Готовая задача", column: "done" }, actor);
      let plan = await emptyPlan(service, "Завершение");
      plan = await service.stageTask(plan.id, stageId(plan), task.id, false, write(plan, actor));
      const writer = ProjectDatabase.open(db.path);
      let commits = 0;
      const store: CommandStore = {
        projectId: db.projectId,
        /**
         * Возвращает согласованную исходную выборку настоящего адаптера.
         */
        load: (request) => db.commands.load(request),
        /**
         * Меняет граф после pure расчёта завершения, пока исходный plan CAS ещё актуален.
         */
        async commit(prepared) {
          commits++;
          await new TasksService(writer).move(task.id, { column: "ready" }, write(task, actor));
          return db.commands.commit(prepared);
        },
      };
      try {
        await expectAsyncRelayError(
          () =>
            new CommandExecutor(store).execute(
              {
                op: "plan.complete",
                ref: plan.id,
                ifRevision: plan.revision,
                input: { result: "Готово" },
              },
              { actor },
            ),
          "COMMAND_CONTEXT_CHANGED",
        );

        expect(commits).toBe(1);
        expect(service.get("work-plan", plan.id)).toEqual(plan);
        expect(tasks.get(task.id).data.column).toBe("ready");
        expect(service.progress("work-plan", plan.id).completed).toBe(false);
      } finally {
        writer.close();
      }
    });
  });

  test("complete и publish разделяют граф overlay; поздний reopen разрешён и не переписывает закрытые owners", async () => {
    await withEntityDatabase(async (db) => {
      const service = new PlanningService(db);
      const tasks = new TasksService(db);
      const dependency = await tasks.create({ title: "Зависимость", column: "done" }, actor);
      const task = await tasks.create(
        { title: "Работа", column: "done", dependencies: [dependency.id] },
        actor,
      );
      let plan = await emptyPlan(service, "Выпуск");
      plan = await service.stageTask(plan.id, stageId(plan), task.id, false, write(plan, actor));
      const release = await service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [plan.id] },
        actor,
      );
      const observed: PlanningObservedGraph[] = [];
      const original = TaskGraphCache.prototype.get;
      const graph = spyOn(TaskGraphCache.prototype, "get").mockImplementation(function (
        this: TaskGraphCache,
        records,
        candidate,
      ) {
        const instance = original.call(this, records, candidate);
        observed.push({ instance, progress: instance.progress(task.id) });
        return instance;
      });
      const loads = spyOn(db.commands, "load");
      try {
        const result = await new CommandExecutor(db.commands).executeCommands(
          [
            {
              op: "plan.complete",
              ref: plan.id,
              ifRevision: plan.revision,
              input: { result: "Завершено" },
            },
            { op: "release.publish", ref: release.id, ifRevision: release.revision },
            {
              op: "task.move",
              ref: dependency.id,
              ifRevision: dependency.revision,
              input: { column: "ready" },
            },
          ],
          { actor, operationKey: "publish-before-reopen" },
        );

        expect(result.items.map((item) => item.op)).toEqual([
          "plan.complete",
          "release.publish",
          "task.move",
        ]);
        expect(service.get("work-plan", plan.id).data).toMatchObject({
          status: "completed",
          result: "Завершено",
        });
        expect(service.get("release", release.id).data).toMatchObject({
          status: "released",
          releasedBy: actor,
        });
        expect(observed[0]?.instance).toBe(observed[1]?.instance);
        expect(observed[0]?.progress.completed).toBe(true);
        expect(observed.at(-1)?.instance).not.toBe(observed[0]?.instance);
        expect(observed.at(-1)?.progress.completed).toBe(false);
        expect(
          loads.mock.calls
            .flatMap(([request]) => request.selectors)
            .filter((selector) => selector.kind === "task-graph"),
        ).toHaveLength(1);
      } finally {
        graph.mockRestore();
        loads.mockRestore();
      }
      expect(service.progress("release", release.id).completed).toBe(false);
    });
  });

  test("CLI scope строки разрешаются внутри command port и проверяют клиентский address guard", async () => {
    await withEntityDatabase(async (db) => {
      const product = db.getIdentity("PRODUCT");
      if (product === undefined) {
        throw new Error("Отсутствует начальный продукт");
      }
      const service = new PlanningService(db, {
        expectedAddresses: [{ ref: "PRODUCT", expectedId: product.id }],
      });
      const plan = await service.create(
        "work-plan",
        { title: "CLI область", scope: ["project:PROJECT", "PRODUCT"] },
        actor,
      );

      expect(plan.data.scope).toEqual([
        { kind: "project", id: db.projectId },
        { kind: "product", id: product.id },
      ]);
      const generation = db.getGeneration();
      await expectAsyncRelayError(
        () =>
          new PlanningService(db, {
            expectedAddresses: [{ ref: "PRODUCT", expectedId: "old-product" }],
          }).update("work-plan", plan.id, { scope: ["PRODUCT"] }, write(plan, actor)),
        "ADDRESS_CHANGED",
      );
      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("проверка membership читает только выбранных владельцев и не скрывает их повреждение", async () => {
    await withEntityDatabase(async (db) => {
      const service = new PlanningService(db);
      const tasks = new TasksService(db);
      const task = await tasks.create({ title: "Выбранная задача" }, actor);
      const owner = await emptyPlan(service, "Владелец");
      const unrelated = await emptyPlan(service, "Посторонний");
      db.update(
        {
          ...unrelated,
          revision: unrelated.revision + 1,
          data: { ...unrelated.data, status: "broken-unrelated" },
        },
        unrelated.revision,
      );
      const loads = spyOn(db.commands, "load");
      let included: WorkPlanRecord;
      try {
        included = await service.stageTask(
          owner.id,
          stageId(owner),
          task.id,
          false,
          write(owner, actor),
        );
        expect(included.data.stages[0]?.taskIds).toEqual([task.id]);
        expect(
          loads.mock.calls
            .flatMap(([request]) => request.selectors)
            .some((selector) => selector.kind === "kind"),
        ).toBe(false);
      } finally {
        loads.mockRestore();
      }
      // Повреждённый статус именно относящегося к задаче owner обязан попасть в decoder.
      db.update(
        {
          ...included,
          revision: included.revision + 1,
          data: { ...included.data, status: "broken-relevant" },
        },
        included.revision,
      );
      const target = await emptyPlan(service, "Новый получатель");
      const generation = db.getGeneration();

      await expectAsyncRelayError(
        () => service.stageTask(target.id, stageId(target), task.id, false, write(target, actor)),
        "CORRUPT_DATA",
      );
      expect(service.get("work-plan", target.id)).toEqual(target);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});
