import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  RelayError,
  type EntityRecord,
  type TaskRecord,
  type WorkPlanRecord,
  type ReleaseRecord,
  type WriteOptions,
} from "@relay/contracts";
import { KnowledgeService, PlanningService, TasksService } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";

const actor = "workflow-qa";

interface Fixture {
  db: ProjectDatabase;
  knowledge: KnowledgeService;
  tasks: TasksService;
  planning: PlanningService;
}

interface Workflow {
  feature: EntityRecord;
  scenario: EntityRecord;
  application: EntityRecord;
  fi: EntityRecord;
  si: EntityRecord;
  preparation: TaskRecord;
  implementation: TaskRecord;
  acceptance: TaskRecord;
  plan: WorkPlanRecord;
  stageId: string;
  release: ReleaseRecord;
}

function services(db: ProjectDatabase): Fixture {
  return {
    db,
    knowledge: new KnowledgeService(db),
    tasks: new TasksService(db),
    planning: new PlanningService(db),
  };
}

function withProject(run: (fixture: Fixture) => void): void {
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
    run(services(db));
  } finally {
    try {
      db?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function write(entity: EntityRecord): WriteOptions {
  return { actor, ifRevision: entity.revision };
}

function firstId(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("Ожидался массив с локальными ID");
  const item: unknown = value[0];
  if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") {
    throw new Error("У первого элемента отсутствует локальный ID");
  }
  return item.id;
}

function snapshot(db: ProjectDatabase) {
  return { entities: db.list(), generation: db.getGeneration() };
}

function expectAtomicFailure(db: ProjectDatabase, operation: () => unknown, code: string): void {
  const before = snapshot(db);
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RelayError);
  if (!(failure instanceof RelayError)) throw new Error("Ожидалась предметная ошибка Relay");
  expect(failure.code).toBe(code);
  expect(snapshot(db)).toEqual(before);
}

function createWorkflow({ knowledge, tasks, planning }: Fixture): Workflow {
  const feature = knowledge.create("feature", { name: "Локальный экспорт" }, actor);
  const scenario = knowledge.create(
    "scenario",
    { name: "Сохранить выбранные данные", feature: feature.key },
    actor,
  );
  const application = knowledge.create(
    "application",
    { name: "Консольный клиент", slug: "console", prefix: "CONSOLE", type: "internal" },
    actor,
  );
  const fi = knowledge.create(
    "implementation",
    { application: application.key, target: feature.key, title: "Команды экспорта" },
    actor,
  );
  const si = knowledge.create(
    "implementation",
    { application: application.id, target: scenario.key, title: "Запись выбранных данных" },
    actor,
  );
  const preparation = tasks.create(
    { board: "console", title: "Подготовить файловый адаптер" },
    actor,
  );
  let implementation = tasks.create(
    {
      board: "console",
      title: "Реализовать команду экспорта",
      targets: [fi.key, si.id],
      acceptanceCriteria: [{ title: "Выбранные данные записываются без потерь" }],
    },
    actor,
  );
  implementation = tasks.dependency(
    implementation.key,
    preparation.key,
    false,
    write(implementation),
  );
  const acceptance = tasks.create(
    {
      title: "Принять пользовательский сценарий",
      targets: [scenario.key],
      dependencies: [implementation.key],
    },
    actor,
  );
  let plan = planning.create(
    "work-plan",
    {
      title: "Локальный экспорт через CLI",
      goal: "Дать пользователю сохранение выбранных данных без сервера.",
      scope: [
        { kind: "feature", id: feature.key },
        { kind: "application", id: application.key },
        { kind: "implementation", id: si.key },
      ],
    },
    actor,
  );
  plan = planning.stage(plan.key, "create", { title: "Реализация и приёмка" }, write(plan));
  const stageId = firstId(plan.data.stages);
  plan = planning.stageTask(plan.key, stageId, implementation.key, false, write(plan));
  plan = planning.stageTask(plan.id, stageId, acceptance.id, false, write(plan));
  const release = planning.create(
    "release",
    { title: "Первый локальный экспорт", version: "1.0.0", planIds: [plan.key] },
    actor,
  );
  return {
    feature,
    scenario,
    application,
    fi,
    si,
    preparation,
    implementation,
    acceptance,
    plan,
    stageId,
    release,
  };
}

function finishTasks({ tasks }: Fixture, workflow: Workflow): void {
  tasks.move(
    workflow.preparation.id,
    { column: "done" },
    write(tasks.get(workflow.preparation.id)),
  );
  let implementation = tasks.get(workflow.implementation.id);
  implementation = tasks.criterion(
    implementation.id,
    "complete",
    { id: firstId(implementation.data.acceptanceCriteria) },
    write(implementation),
  );
  tasks.move(implementation.id, { column: "done" }, write(implementation));
  tasks.move(workflow.acceptance.id, { column: "done" }, write(tasks.get(workflow.acceptance.id)));
}

describe("Связный рабочий цикл знаний, задач, планов и релизов", () => {
  test("требования и реализации проходят через критерии и внешнюю зависимость до выпуска", () => {
    withProject((fixture) => {
      const { db, knowledge, tasks, planning } = fixture;
      const workflow = createWorkflow(fixture);
      const { feature, scenario, application, fi, si, preparation, acceptance, stageId } = workflow;
      let { implementation, plan, release } = workflow;

      expect(scenario.data.featureId).toBe(feature.id);
      expect(fi.data).toMatchObject({ applicationId: application.id, targetId: feature.id });
      expect(si.data).toMatchObject({
        applicationId: application.id,
        featureId: feature.id,
        targetId: scenario.id,
        scenarioId: scenario.id,
      });
      expect(implementation.data.boardId).toBe(
        knowledge.get("application", application.id).data.boardId,
      );
      expect(implementation.data.targets).toEqual([fi.id, si.id]);
      expect(acceptance.data.targets).toEqual([scenario.id]);
      expect(preparation.data.targets).toEqual([]);
      expect(acceptance.data.dependencies).toEqual([implementation.id]);
      expect(plan.data.scope).toEqual([
        { kind: "feature", id: feature.id },
        { kind: "application", id: application.id },
        { kind: "implementation", id: si.id },
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

      plan = planning.transition("work-plan", plan.id, "start", {}, write(plan));
      expect(tasks.get(implementation.id)).toEqual(implementation);
      expectAtomicFailure(
        db,
        () =>
          planning.transition("work-plan", plan.id, "complete", { result: "Готово" }, write(plan)),
        "NOT_READY",
      );
      expectAtomicFailure(
        db,
        () => tasks.move(implementation.id, { column: "done" }, write(implementation)),
        "TASK_INCOMPLETE",
      );

      implementation = tasks.criterion(
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
      tasks.move(preparation.id, { column: "done" }, write(preparation));
      expect(tasks.progress(implementation.id)).toEqual({
        completed: false,
        canComplete: true,
        blockers: [],
      });
      implementation = tasks.move(implementation.id, { column: "done" }, write(implementation));
      expect(planning.progress("work-plan", plan.id)).toMatchObject({
        counts: { total: 2, completed: 1, percent: 50 },
      });
      tasks.move(acceptance.id, { column: "done" }, write(acceptance));
      expect(planning.progress("work-plan", plan.id)).toMatchObject({
        completed: true,
        canComplete: true,
        counts: { total: 2, completed: 2, percent: 100 },
      });
      // Выполненный состав ещё не означает явно завершённый план.
      expect(planning.progress("release", release.id).canRelease).toBe(false);
      expectAtomicFailure(
        db,
        () => planning.transition("release", release.id, "publish", {}, write(release)),
        "NOT_READY",
      );
      plan = planning.transition(
        "work-plan",
        plan.id,
        "complete",
        { result: "Команда реализована, пользовательский сценарий принят." },
        write(plan),
      );
      expect(plan.data.status).toBe("completed");
      expect(planning.progress("release", release.id).canRelease).toBe(true);
      expect(planning.get("release", release.id)).toEqual(release);
      release = planning.transition("release", release.id, "publish", {}, write(release));
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

  test("публикация перечитывает обязательства из другой SQLite-сессии даже у закрытого плана", () => {
    withProject((fixture) => {
      const { db, tasks, planning } = fixture;
      const workflow = createWorkflow(fixture);
      finishTasks(fixture, workflow);
      const plan = planning.transition(
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
        preparation = otherTasks.move(preparation.id, { column: "review" }, write(preparation));

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
        expectAtomicFailure(
          db,
          () => planning.transition("release", release.id, "publish", {}, write(release)),
          "NOT_READY",
        );

        preparation = otherTasks.move(preparation.id, { column: "done" }, write(preparation));
        release = planning.transition("release", release.id, "publish", {}, write(release));
        expect(planning.progress("release", release.id).completed).toBe(true);

        // После выпуска меняется только текущая готовность, а факт выпуска сохраняется.
        otherTasks.move(preparation.id, { column: "review" }, write(preparation));
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

  test("снятие участия и перенос доски сохраняют цели, зависимости и явное включение задачи", () => {
    withProject((fixture) => {
      const { db, knowledge, tasks, planning } = fixture;
      const workflow = createWorkflow(fixture);
      const { feature, scenario, fi, si, plan, stageId, acceptance } = workflow;
      let implementation = workflow.implementation;
      let application = knowledge.get("application", workflow.application.id);
      const progress = planning.progress("work-plan", plan.id);
      const productTasks = () =>
        tasks
          .list({ productTarget: feature.key })
          .map((task) => task.id)
          .sort();
      expect(productTasks()).toEqual([implementation.id, acceptance.id].sort());

      expectAtomicFailure(
        db,
        () => tasks.move(implementation.id, { board: "product" }, write(implementation)),
        "INVALID_ARGUMENT",
      );
      application = knowledge.replaceParticipation(application.id, [], write(application));
      expect(knowledge.get("implementation", fi.key).data.active).toBe(false);
      expect(knowledge.get("implementation", si.key).data.active).toBe(false);
      expect(productTasks()).toEqual([acceptance.id]);
      expect(tasks.get(implementation.id)).toEqual(implementation);
      expect(tasks.list({ target: si.key }).map((task) => task.id)).toEqual([implementation.id]);
      expect(planning.get("work-plan", plan.id)).toEqual(plan);
      expect(planning.progress("work-plan", plan.id)).toEqual(progress);
      expectAtomicFailure(
        db,
        () => tasks.create({ board: "console", title: "Новая работа", targets: [si.key] }, actor),
        "INVALID_ARGUMENT",
      );
      implementation = tasks.update(
        implementation.id,
        { description: "Существующая ссылка сохраняется после снятия участия." },
        write(implementation),
      );
      expect(implementation.data.targets).toEqual([fi.id, si.id]);

      knowledge.replaceParticipation(application.id, [fi.key, si.key], write(application));
      expect(knowledge.get("implementation", fi.id)).toMatchObject({ id: fi.id, key: fi.key });
      expect(knowledge.get("implementation", si.id)).toMatchObject({
        id: si.id,
        key: si.key,
        data: { active: true },
      });
      expect(productTasks()).toEqual([implementation.id, acceptance.id].sort());

      const oldKey = implementation.key;
      implementation = tasks.update(implementation.id, { targets: [] }, write(implementation));
      implementation = tasks.move(implementation.id, { board: "product" }, write(implementation));
      implementation = tasks.update(
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
      expect(planning.stageTask(plan.id, stageId, oldKey, false, write(plan))).toEqual(plan);
      expect(snapshot(db)).toEqual(before);
    });
  });

  test("поздний отказ завершения плана откатывает весь пакет знаний и задач вместе с адресами", () => {
    withProject((fixture) => {
      const { db, knowledge, tasks, planning } = fixture;
      const initialIds = new Set(db.list().map((entity) => entity.id));
      const attempted: EntityRecord[] = [];
      let allocatedKeys: string[] = [];

      expectAtomicFailure(
        db,
        () =>
          db.transaction(() => {
            const workflow = createWorkflow(fixture);
            allocatedKeys = db.list().map((entity) => entity.key);
            attempted.push(...db.list().filter((entity) => !initialIds.has(entity.id)));
            knowledge.rename(
              "feature",
              workflow.feature.id,
              "FEATURE-EXPORT",
              write(workflow.feature),
            );
            tasks.move(workflow.preparation.id, { column: "done" }, write(workflow.preparation));
            tasks.criterion(
              workflow.implementation.id,
              "complete",
              { id: firstId(workflow.implementation.data.acceptanceCriteria) },
              write(workflow.implementation),
            );
            planning.transition(
              "work-plan",
              workflow.plan.id,
              "complete",
              { result: "Недостаточно: задачи ещё не переведены в done." },
              write(workflow.plan),
            );
          }),
        "NOT_READY",
      );

      expect(attempted.length).toBeGreaterThan(0);
      for (const entity of attempted) {
        expect(db.get(entity.id)).toBeUndefined();
        expect(db.get(entity.key)).toBeUndefined();
      }
      expect(db.get("FEATURE-EXPORT")).toBeUndefined();
      // Проверяем и счётчики: откат не расходует ключи приложений, задач, планов и релизов.
      createWorkflow(fixture);
      expect(db.list().map((entity) => entity.key)).toEqual(allocatedKeys);
    });
  });
});
