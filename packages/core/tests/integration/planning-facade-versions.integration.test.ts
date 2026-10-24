import { describe, expect, test } from "bun:test";
import { CommandExecutor } from "../../src/batch/batch";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import {
  entityWriteOptions as write,
  expectAsyncRelayError,
  withEntityDatabase,
} from "./helpers/entity-fixture";

const actor = "planning-version-facade";
const invalidTransferConditions = [
  {
    name: "нулевой CAS источника при token",
    conditions: { ifRevision: 0 },
    code: "VALIDATION_ERROR",
  },
  {
    name: "нулевой CAS получателя при token",
    conditions: { targetRevision: 0 },
    code: "VALIDATION_ERROR",
  },
  {
    name: "устаревший CAS источника при актуальном token",
    conditions: { ifRevision: 1 },
    code: "REVISION_CONFLICT",
  },
  {
    name: "пустой token получателя при CAS",
    conditions: { targetVersion: "" },
    code: "INVALID_ARGUMENT",
  },
] as const;

describe("Переносимые версии public planning facade", () => {
  test("constructor token допускает version-only update, явный token метода имеет приоритет, stale no-op отклоняется", async () => {
    await withEntityDatabase(async (db) => {
      const service = new PlanningService(db);
      const plan = await service.create("work-plan", { title: "Версия заголовка" }, actor);
      const executor = new CommandExecutor(db.commands);
      const initial = await executor.readVersioned(plan.id, "work-plan");
      const inherited = new PlanningService(db, {
        expectedVersion: initial.versions.aggregateVersion,
      });

      const updated = await inherited.update(
        "work-plan",
        plan.id,
        { title: "Первая правка" },
        { actor },
      );
      const current = await executor.readVersioned(plan.id, "work-plan");
      const override = await inherited.update(
        "work-plan",
        plan.id,
        { title: "Явная версия" },
        { actor, expectedVersion: current.versions.aggregateVersion },
      );

      expect(updated.revision).toBe(plan.revision + 1);
      expect(override.data.title).toBe("Явная версия");
      expect(override.revision).toBe(updated.revision + 1);
      const generation = db.getGeneration();
      await expectAsyncRelayError(
        () => inherited.update("work-plan", plan.id, { title: override.data.title }, { actor }),
        "VERSION_CONFLICT",
      );
      await expectAsyncRelayError(
        () => service.update("work-plan", plan.id, { title: "Без условия" }, { actor }),
        "VALIDATION_ERROR",
      );
      await expectAsyncRelayError(
        () =>
          inherited.update(
            "work-plan",
            plan.id,
            { title: "Неверный CAS" },
            { actor, ifRevision: 0 },
          ),
        "VALIDATION_ERROR",
      );
      const unknownOptions = {
        actor,
        expectedVersion: current.versions.aggregateVersion,
        unexpected: true,
      };
      await expectAsyncRelayError(
        () => service.update("work-plan", plan.id, { title: "Лишнее поле" }, unknownOptions),
        "VALIDATION_ERROR",
      );
      expect(service.get("work-plan", plan.id)).toEqual(override);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("version-only facade этапов, включения и переходов возвращает проверенные карточки", async () => {
    await withEntityDatabase(async (db) => {
      const service = new PlanningService(db);
      const executor = new CommandExecutor(db.commands);
      const task = await new TasksService(db).create(
        { title: "Готовая работа", column: "done" },
        actor,
      );
      const plan = await service.create("work-plan", { title: "План" }, actor);
      const planView = await executor.readVersioned(plan.id, "work-plan");
      const staged = await service.stage(
        plan.id,
        "create",
        { title: "Этап" },
        { actor, expectedVersion: planView.versions.aggregateVersion },
      );
      const stage = staged.data.stages[0];
      if (stage === undefined) {
        throw new Error("Не создан этап");
      }
      const stageView = await executor.readVersioned(plan.id, "work-plan");
      const included = await service.stageTask(plan.id, stage.id, task.id, false, {
        actor,
        expectedVersion: stageView.versions.aggregateVersion,
      });
      const includedView = await executor.readVersioned(plan.id, "work-plan");
      const completed = await service.transition(
        "work-plan",
        plan.id,
        "complete",
        { result: "Готово" },
        { actor, expectedVersion: includedView.versions.aggregateVersion },
      );
      const release = await service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [plan.id] },
        actor,
      );
      const releaseView = await executor.readVersioned(release.id, "release");
      const published = await new PlanningService(db, {
        expectedVersion: releaseView.versions.aggregateVersion,
      }).transition("release", release.id, "publish", {}, { actor });

      expect(included.data.stages[0]?.taskIds).toEqual([task.id]);
      expect(completed.data).toMatchObject({ status: "completed", result: "Готово" });
      expect(published.data).toMatchObject({ status: "released", releasedBy: actor });
      expect(service.get("release", release.id)).toEqual(published);
    });
  });

  test("transfer facade принимает constructor token источника и targetVersion без numeric заглушек", async () => {
    await withEntityDatabase(async (db) => {
      const service = new PlanningService(db);
      const executor = new CommandExecutor(db.commands);
      const task = await new TasksService(db).create({ title: "Перенос" }, actor);
      let source = await service.create("work-plan", { title: "Источник" }, actor);
      source = await service.stage(
        source.id,
        "create",
        { title: "Исходный этап" },
        write(source, actor),
      );
      const sourceStage = source.data.stages[0];
      if (sourceStage === undefined) {
        throw new Error("Нет исходного этапа");
      }
      source = await service.stageTask(
        source.id,
        sourceStage.id,
        task.id,
        false,
        write(source, actor),
      );
      let target = await service.create("work-plan", { title: "Получатель" }, actor);
      target = await service.stage(
        target.id,
        "create",
        { title: "Целевой этап" },
        write(target, actor),
      );
      const targetStage = target.data.stages[0];
      if (targetStage === undefined) {
        throw new Error("Нет целевого этапа");
      }
      const sourceView = await executor.readVersioned(source.id, "work-plan");
      const targetView = await executor.readVersioned(target.id, "work-plan");
      const facade = new PlanningService(db, {
        expectedVersion: sourceView.versions.aggregateVersion,
      });

      await expectAsyncRelayError(
        () =>
          facade.transfer(
            source.id,
            {
              task: task.id,
              targetPlan: target.id,
              targetStage: targetStage.id,
              reason: "Без условия получателя",
            },
            { actor },
          ),
        "VALIDATION_ERROR",
      );
      const moved = await facade.transfer(
        source.id,
        { task: task.id, targetPlan: target.id, targetStage: targetStage.id, reason: "По версиям" },
        {
          actor,
          targetVersion: targetView.versions.aggregateVersion,
        },
      );

      expect(moved.source.data.stages[0]?.taskIds).toEqual([]);
      expect(moved.target.data.stages[0]?.taskIds).toEqual([task.id]);
      expect(moved.source.revision).toBe(source.revision + 1);
      expect(moved.target.revision).toBe(target.revision + 1);
      expect(service.get("work-plan", source.id)).toEqual(moved.source);
      expect(service.get("work-plan", target.id)).toEqual(moved.target);
    });
  });

  test.each(invalidTransferConditions)(
    "$name отклоняется до no-op без изменения владельца",
    async ({ conditions, code }) => {
      await withEntityDatabase(async (db) => {
        const service = new PlanningService(db);
        const executor = new CommandExecutor(db.commands);
        const task = await new TasksService(db).create({ title: "Сохранить включение" }, actor);
        let plan = await service.create("work-plan", { title: "Один владелец" }, actor);
        plan = await service.stage(plan.id, "create", { title: "Этап" }, write(plan, actor));
        const stage = plan.data.stages[0];
        if (stage === undefined) {
          throw new Error("Нет этапа переноса");
        }
        plan = await service.stageTask(plan.id, stage.id, task.id, false, write(plan, actor));
        const view = await executor.readVersioned(plan.id, "work-plan");
        const generation = db.getGeneration();
        const outbox = db.getReplicationOutbox();

        await expectAsyncRelayError(
          () =>
            service.transfer(
              plan.id,
              { task: task.id, targetPlan: plan.id, targetStage: stage.id, reason: "Повтор" },
              {
                actor,
                expectedVersion: view.versions.aggregateVersion,
                targetVersion: view.versions.aggregateVersion,
                targetRevision: plan.revision,
                ...conditions,
              },
            ),
          code,
        );

        expect(service.get("work-plan", plan.id)).toEqual(plan);
        expect(db.getGeneration()).toBe(generation);
        expect(db.getReplicationOutbox()).toEqual(outbox);
      });
    },
  );
});
