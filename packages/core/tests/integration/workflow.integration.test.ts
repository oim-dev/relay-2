import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EntityRecord, WriteOptions } from "@relay/contracts";
import { BatchService, KnowledgeService, PlanningService, TasksService } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { CommandContext } from "../../src/commands/command-context";
import { expectAsyncRelayError } from "./helpers/entity-fixture";
import { workflowCommands } from "./helpers/workflow-fixture";
import type { Workflow, WorkflowFixture, WorkflowSnapshot } from "./helpers/workflow-fixture.types";

const actor = "workflow-qa";

/**
 * Связывает предметные сервисы с переданным соединением, не принимая владение им.
 */
function workflowServices(db: ProjectDatabase): WorkflowFixture {
  return {
    db,
    knowledge: new KnowledgeService(db),
    tasks: new TasksService(db),
    planning: new PlanningService(db),
  };
}

/**
 * Создаёт пустой проект в файловой SQLite и удаляет его после завершения async сценария,
 * включая отказ. Дополнительными соединениями владеет вызывающий код.
 */
async function withWorkflowProject(
  run: (fixture: WorkflowFixture) => Promise<void>,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const root = resolve(import.meta.dir, "../../../..", ".artifacts", date);
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "workflow-integration-"));
  let db: ProjectDatabase | undefined;
  try {
    db = ProjectDatabase.create(join(directory, "project.sqlite"), {
      id: crypto.randomUUID(),
      name: "Сквозной рабочий цикл",
      slug: "workflow",
    });
    await run(workflowServices(db));
  } finally {
    try {
      db?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

/**
 * Передаёт исходную ревизию указанной записи без перечитывания или обновления CAS.
 */
function write(entity: EntityRecord): WriteOptions {
  return { actor, ifRevision: entity.revision };
}

/**
 * Возвращает первый локальный ID из подготовленного состава; пустой fixture — ошибка теста.
 */
function firstId(value: readonly Pick<EntityRecord, "id">[]): string {
  const item = value[0];
  if (!item) {
    throw new Error("Ожидался непустой состав с локальными ID");
  }
  return item.id;
}

/**
 * Читает все записи и поколение в одном снимке для сравнения до и после отказа пакета.
 */
function snapshot(db: ProjectDatabase): WorkflowSnapshot {
  return db.snapshot(() => ({ entities: db.list(), generation: db.getGeneration() }));
}

/**
 * Проверяет предметный код отказа и полную сохранность записей и поколения проекта.
 */
async function expectAtomicFailure(
  db: ProjectDatabase,
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const before = snapshot(db);
  await expectAsyncRelayError(operation, code);
  expect(snapshot(db)).toEqual(before);
}

/**
 * Создаёт связный маршрут знаний, задач и планирования. Подготовка остаётся внешним
 * обязательством, а план содержит только реализацию и приёмку; все задачи открыты.
 */
async function createWorkflow({ knowledge, tasks, planning }: WorkflowFixture): Promise<Workflow> {
  const feature = await knowledge.create("feature", { name: "Локальный экспорт" }, actor);
  const scenario = await knowledge.create(
    "scenario",
    { name: "Сохранить выбранные данные", feature: feature.key },
    actor,
  );
  const application = await knowledge.create(
    "application",
    { name: "Консольный клиент", slug: "console", prefix: "CONSOLE", type: "internal" },
    actor,
  );
  const featureImplementation = await knowledge.create(
    "implementation",
    { application: application.key, target: feature.key, title: "Команды экспорта" },
    actor,
  );
  const scenarioImplementation = await knowledge.create(
    "implementation",
    { application: application.id, target: scenario.key, title: "Запись выбранных данных" },
    actor,
  );
  const preparation = await tasks.create(
    { board: "console", title: "Подготовить файловый адаптер" },
    actor,
  );
  let implementation = await tasks.create(
    {
      board: "console",
      title: "Реализовать команду экспорта",
      targets: [featureImplementation.key, scenarioImplementation.id],
      acceptanceCriteria: [{ title: "Выбранные данные записываются без потерь" }],
    },
    actor,
  );
  implementation = await tasks.dependency(
    implementation.key,
    preparation.key,
    false,
    write(implementation),
  );
  const acceptance = await tasks.create(
    {
      title: "Принять пользовательский сценарий",
      targets: [scenario.key],
      dependencies: [implementation.key],
    },
    actor,
  );
  let plan = await planning.create(
    "work-plan",
    {
      title: "Локальный экспорт через CLI",
      goal: "Дать пользователю сохранение выбранных данных без сервера.",
      scope: [
        { kind: "feature", id: feature.key },
        { kind: "application", id: application.key },
        { kind: "implementation", id: scenarioImplementation.key },
      ],
    },
    actor,
  );
  plan = await planning.stage(plan.key, "create", { title: "Реализация и приёмка" }, write(plan));
  const stageId = firstId(plan.data.stages);
  plan = await planning.stageTask(plan.key, stageId, implementation.key, false, write(plan));
  plan = await planning.stageTask(plan.id, stageId, acceptance.id, false, write(plan));
  const release = await planning.create(
    "release",
    { title: "Первый локальный экспорт", version: "1.0.0", planIds: [plan.key] },
    actor,
  );
  return {
    feature,
    scenario,
    application,
    featureImplementation,
    scenarioImplementation,
    preparation,
    implementation,
    acceptance,
    plan,
    stageId,
    release,
  };
}

/**
 * Завершает неизменённый после подготовки маршрут по его исходным ревизиям.
 * Критерий выполняется перед закрытием реализации; план и релиз не изменяются.
 */
async function finishWorkflowTasks({ tasks }: WorkflowFixture, workflow: Workflow): Promise<void> {
  await tasks.move(workflow.preparation.id, { column: "done" }, write(workflow.preparation));
  let implementation = workflow.implementation;
  implementation = await tasks.criterion(
    implementation.id,
    "complete",
    { id: firstId(implementation.data.acceptanceCriteria) },
    write(implementation),
  );
  await tasks.move(implementation.id, { column: "done" }, write(implementation));
  await tasks.move(workflow.acceptance.id, { column: "done" }, write(workflow.acceptance));
}

/**
 * Возвращает ID задач продуктового охвата без зависимости от порядка выдачи.
 */
function productTaskIds(tasks: TasksService, reference: string): string[] {
  return tasks
    .list({ productTarget: reference })
    .map((task) => task.id)
    .sort();
}

describe("Связный рабочий цикл знаний, задач, планов и релизов", () => {
  test("требования и реализации проходят через критерии и внешнюю зависимость до выпуска", async () => {
    await withWorkflowProject(async (fixture) => {
      const { db, knowledge, tasks, planning } = fixture;
      const workflow = await createWorkflow(fixture);
      const {
        feature,
        scenario,
        application,
        featureImplementation,
        scenarioImplementation,
        preparation,
        acceptance,
        stageId,
      } = workflow;
      let { implementation, plan, release } = workflow;

      expect(scenario.data.featureId).toBe(feature.id);
      expect(featureImplementation.data).toMatchObject({
        applicationId: application.id,
        targetId: feature.id,
      });
      expect(scenarioImplementation.data).toMatchObject({
        applicationId: application.id,
        featureId: feature.id,
        targetId: scenario.id,
        scenarioId: scenario.id,
      });
      expect(implementation.data.boardId).toBe(
        knowledge.get("application", application.id).data.boardId,
      );
      expect(implementation.data.targets).toEqual([
        featureImplementation.id,
        scenarioImplementation.id,
      ]);
      expect(acceptance.data.targets).toEqual([scenario.id]);
      expect(preparation.data.targets).toEqual([]);
      expect(acceptance.data.dependencies).toEqual([implementation.id]);
      expect(plan.data.scope).toEqual([
        { kind: "feature", id: feature.id },
        { kind: "application", id: application.id },
        { kind: "implementation", id: scenarioImplementation.id },
      ]);
      expect(release.data.planIds).toEqual([plan.id]);
      // Зависимость влияет на готовность, но не попадает в явный состав плана.
      expect(plan.data.stages).toMatchObject([
        { id: stageId, taskIds: [implementation.id, acceptance.id] },
      ]);
      expect(tasks.get(implementation.id)).toEqual(implementation);
      expect(tasks.get(acceptance.id)).toEqual(acceptance);
      expect(planning.progress("work-plan", plan.id)).toMatchObject({
        completed: false,
        counts: { total: 2, completed: 0, percent: 0 },
      });

      plan = await planning.transition("work-plan", plan.id, "start", {}, write(plan));

      expect(tasks.get(implementation.id)).toEqual(implementation);
      await expectAtomicFailure(
        db,
        () =>
          planning.transition("work-plan", plan.id, "complete", { result: "Готово" }, write(plan)),
        "NOT_READY",
      );
      await expectAtomicFailure(
        db,
        () => tasks.move(implementation.id, { column: "done" }, write(implementation)),
        "TASK_INCOMPLETE",
      );

      implementation = await tasks.criterion(
        implementation.id,
        "complete",
        { id: firstId(implementation.data.acceptanceCriteria) },
        write(implementation),
      );

      expect(tasks.progress(implementation.id)).toEqual({
        completed: false,
        canComplete: false,
        blockers: [preparation.id],
      });

      await tasks.move(preparation.id, { column: "done" }, write(preparation));

      expect(tasks.progress(implementation.id)).toEqual({
        completed: false,
        canComplete: true,
        blockers: [],
      });

      implementation = await tasks.move(
        implementation.id,
        { column: "done" },
        write(implementation),
      );

      expect(planning.progress("work-plan", plan.id)).toMatchObject({
        counts: { total: 2, completed: 1, percent: 50 },
      });

      await tasks.move(acceptance.id, { column: "done" }, write(acceptance));

      expect(planning.progress("work-plan", plan.id)).toMatchObject({
        completed: true,
        canComplete: true,
        counts: { total: 2, completed: 2, percent: 100 },
      });
      // Выполненный состав ещё не означает явно завершённый план.
      expect(planning.progress("release", release.id).canRelease).toBe(false);
      await expectAtomicFailure(
        db,
        () => planning.transition("release", release.id, "publish", {}, write(release)),
        "NOT_READY",
      );
      plan = await planning.transition(
        "work-plan",
        plan.id,
        "complete",
        { result: "Команда реализована, пользовательский сценарий принят." },
        write(plan),
      );

      expect(plan.data.status).toBe("completed");
      expect(planning.progress("release", release.id).canRelease).toBe(true);
      expect(planning.get("release", release.id)).toEqual(release);

      release = await planning.transition("release", release.id, "publish", {}, write(release));

      expect(release.data).toMatchObject({ status: "released", releasedBy: actor });
      expect(typeof release.data.releasedAt).toBe("string");

      const persisted = snapshot(db);
      db.close();
      const reopened = ProjectDatabase.open(db.path);
      try {
        expect(snapshot(reopened)).toEqual(persisted);
        expect(new PlanningService(reopened).progress("release", release.key)).toMatchObject({
          completed: true,
          canRelease: true,
        });
      } finally {
        reopened.close();
      }
    });
  });

  test("публикация перечитывает обязательства из другой SQLite-сессии даже у закрытого плана", async () => {
    await withWorkflowProject(async (fixture) => {
      const { db, tasks, planning } = fixture;
      const workflow = await createWorkflow(fixture);
      await finishWorkflowTasks(fixture, workflow);
      const plan = await planning.transition(
        "work-plan",
        workflow.plan.id,
        "complete",
        { result: "Реализация и приёмка завершены." },
        write(workflow.plan),
      );
      let release = workflow.release;
      expect(planning.progress("release", release.id).canRelease).toBe(true);

      const otherDb = ProjectDatabase.open(db.path);
      try {
        const otherTasks = new TasksService(otherDb);
        let preparation = otherTasks.get(workflow.preparation.id);
        preparation = await otherTasks.move(
          preparation.id,
          { column: "review" },
          write(preparation),
        );

        expect(tasks.get(workflow.implementation.id).data.column).toBe("done");
        expect(tasks.get(workflow.acceptance.id).data.column).toBe("done");
        expect(tasks.progress(workflow.implementation.id)).toEqual({
          completed: false,
          canComplete: false,
          blockers: [preparation.id],
        });
        expect(tasks.progress(workflow.acceptance.id).blockers).toEqual([
          workflow.implementation.id,
        ]);
        expect(planning.get("work-plan", plan.id)).toEqual(plan);
        expect(planning.progress("work-plan", plan.id)).toMatchObject({
          completed: false,
          counts: { total: 2, completed: 0, percent: 0 },
        });
        expect(planning.get("release", release.id)).toEqual(release);
        expect(planning.progress("release", release.id).canRelease).toBe(false);
        await expectAtomicFailure(
          db,
          () => planning.transition("release", release.id, "publish", {}, write(release)),
          "NOT_READY",
        );

        preparation = await otherTasks.move(preparation.id, { column: "done" }, write(preparation));
        release = await planning.transition("release", release.id, "publish", {}, write(release));

        expect(planning.progress("release", release.id).completed).toBe(true);

        // После выпуска меняется только текущая готовность, а факт выпуска сохраняется.
        await otherTasks.move(preparation.id, { column: "review" }, write(preparation));

        expect(planning.progress("release", release.id)).toMatchObject({
          completed: false,
          canRelease: false,
        });
        expect(planning.get("work-plan", plan.id)).toEqual(plan);
        expect(planning.get("release", release.id)).toEqual(release);
        expect(new PlanningService(otherDb).get("release", release.id)).toEqual(release);
      } finally {
        otherDb.close();
      }
    });
  });

  test("снятие участия и перенос доски сохраняют цели, зависимости и явное включение задачи", async () => {
    await withWorkflowProject(async (fixture) => {
      const { db, knowledge, tasks, planning } = fixture;
      const workflow = await createWorkflow(fixture);
      const {
        feature,
        scenario,
        featureImplementation,
        scenarioImplementation,
        plan,
        stageId,
        acceptance,
      } = workflow;
      let implementation = workflow.implementation;
      let application = knowledge.get("application", workflow.application.id);
      const progress = planning.progress("work-plan", plan.id);
      expect(productTaskIds(tasks, feature.key)).toEqual([implementation.id, acceptance.id].sort());

      await expectAtomicFailure(
        db,
        () => tasks.move(implementation.id, { board: "product" }, write(implementation)),
        "INVALID_ARGUMENT",
      );
      application = await knowledge.replaceParticipation(application.id, [], write(application));

      expect(knowledge.get("implementation", featureImplementation.key).data.active).toBe(false);
      expect(knowledge.get("implementation", scenarioImplementation.key).data.active).toBe(false);
      expect(productTaskIds(tasks, feature.key)).toEqual([acceptance.id]);
      expect(tasks.get(implementation.id)).toEqual(implementation);
      expect(tasks.list({ target: scenarioImplementation.key }).map((task) => task.id)).toEqual([
        implementation.id,
      ]);
      expect(planning.get("work-plan", plan.id)).toEqual(plan);
      expect(planning.progress("work-plan", plan.id)).toEqual(progress);
      await expectAtomicFailure(
        db,
        () =>
          tasks.create(
            { board: "console", title: "Новая работа", targets: [scenarioImplementation.key] },
            actor,
          ),
        "INVALID_ARGUMENT",
      );
      implementation = await tasks.update(
        implementation.id,
        { description: "Существующая ссылка сохраняется после снятия участия." },
        write(implementation),
      );

      expect(implementation.data.targets).toEqual([
        featureImplementation.id,
        scenarioImplementation.id,
      ]);

      await knowledge.replaceParticipation(
        application.id,
        [featureImplementation.key, scenarioImplementation.key],
        write(application),
      );

      expect(knowledge.get("implementation", featureImplementation.id)).toMatchObject({
        id: featureImplementation.id,
        key: featureImplementation.key,
      });
      expect(knowledge.get("implementation", scenarioImplementation.id)).toMatchObject({
        id: scenarioImplementation.id,
        key: scenarioImplementation.key,
        data: { active: true },
      });
      expect(productTaskIds(tasks, feature.key)).toEqual([implementation.id, acceptance.id].sort());

      const oldKey = implementation.key;
      implementation = await tasks.update(
        implementation.id,
        { targets: [] },
        write(implementation),
      );
      implementation = await tasks.move(
        implementation.id,
        { board: "product" },
        write(implementation),
      );
      implementation = await tasks.update(
        implementation.id,
        { targets: [scenario.key] },
        write(implementation),
      );

      expect(implementation.key).not.toBe(oldKey);
      expect(tasks.get(oldKey)).toEqual(implementation);
      expect(implementation.data).toMatchObject({
        targets: [scenario.id],
        dependencies: [workflow.preparation.id],
        acceptanceCriteria: workflow.implementation.data.acceptanceCriteria,
      });
      expect(tasks.get(acceptance.id)).toEqual(acceptance);
      expect(planning.get("work-plan", plan.id)).toEqual(plan);
      expect(planning.progress("work-plan", plan.id)).toEqual(progress);
      const before = snapshot(db);

      const unchangedPlan = await planning.stageTask(plan.id, stageId, oldKey, false, write(plan));

      expect(unchangedPlan).toEqual(plan);
      expect(snapshot(db)).toEqual(before);
    });
  });

  test("поздний отказ завершения плана откатывает весь пакет знаний и задач вместе с адресами", async () => {
    await withWorkflowProject(async (fixture) => {
      const { db } = fixture;
      const initial = db.list();
      const attempted: EntityRecord[] = [];
      const apply = CommandContext.prototype.apply;
      // Сохраняем реальные allocations неудавшегося исполнения, не подменяя overlay или SQLite.
      const effects = spyOn(CommandContext.prototype, "apply").mockImplementation(function (
        this: CommandContext,
        changes,
      ) {
        apply.call(this, changes);
        for (const change of changes) {
          if (change.kind === "entity" && change.before === null) {
            attempted.push(change.after);
          }
        }
      });
      try {
        await expectAtomicFailure(
          db,
          () =>
            new BatchService(db).execute(
              {
                version: 1,
                operations: [
                  ...workflowCommands(),
                  {
                    op: "feature.rename",
                    ref: { $ref: "feature" },
                    ifRevision: { $revision: "feature" },
                    input: { key: "FEATURE-EXPORT" },
                  },
                  {
                    op: "task.move",
                    ref: { $ref: "preparation" },
                    ifRevision: { $revision: "preparation" },
                    input: { column: "done" },
                  },
                  {
                    op: "task.criterion.complete",
                    ref: { $ref: "implementation" },
                    ifRevision: { $revision: "criterion" },
                    input: { id: { $ref: "criterion" } },
                  },
                  {
                    op: "plan.complete",
                    ref: { $ref: "plan" },
                    ifRevision: { $revision: "acceptance-membership" },
                    input: { result: "Недостаточно: задачи ещё не переведены в done." },
                  },
                ],
              },
              { actor, operationKey: "workflow-rollback" },
            ),
          "NOT_READY",
        );
      } finally {
        effects.mockRestore();
      }

      expect(attempted.length).toBeGreaterThan(0);
      for (const entity of attempted) {
        expect(db.get(entity.id)).toBeUndefined();
        expect(db.get(entity.key)).toBeUndefined();
      }
      expect(db.get("FEATURE-EXPORT")).toBeUndefined();
      expect(db.getBatchReceipt("workflow-rollback")).toBeUndefined();
      // Проверяем и счётчики: откат не расходует ключи приложений, задач, планов и релизов.
      await createWorkflow(fixture);
      expect(db.list().map((entity) => entity.key)).toEqual(
        [...initial, ...attempted].map((entity) => entity.key).sort(),
      );
    });
  });
});
