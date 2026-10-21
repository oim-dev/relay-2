import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RelayError,
  type EntityRecord,
  type WorkPlanRecord,
  type WriteOptions,
} from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../../src/entities";
import { PlanningService, type PlanStage } from "../../src/planning";
import { TasksService } from "../../src/tasks";

const actor = "planning-test";
const markdown = "\n# Полный Markdown\n\n- **Результат**\n\n```ts\nconst answer = 42;\n```\n";

function write(record: EntityRecord): WriteOptions {
  return { actor, ifRevision: record.revision };
}

function stages(record: WorkPlanRecord): PlanStage[] {
  return record.data.stages;
}

function fails(operation: () => unknown, code: string): void {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RelayError);
  expect((error as RelayError).code).toBe(code);
}

function fixture(
  operation: (db: ProjectDatabase, service: PlanningService, tasks: TasksService) => void,
): void {
  const root = fileURLToPath(new URL("../../../../.artifacts/", import.meta.url));
  const parent = join(root, new Date().toISOString().slice(0, 10));
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "planning-integration-"));
  let db: ProjectDatabase | undefined;
  try {
    db = ProjectDatabase.create(join(directory, "project.sqlite"), {
      id: crypto.randomUUID(),
      name: "Планирование",
      slug: "planning",
    });
    operation(db, new PlanningService(db), new TasksService(db));
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function planWithStage(service: PlanningService, title = "План"): WorkPlanRecord {
  const plan = service.create("work-plan", { title, goal: markdown }, actor);
  return service.stage(
    plan.id,
    "create",
    { title: "Этап", outcome: markdown, completionConditions: markdown },
    write(plan),
  );
}

function include(
  service: PlanningService,
  plan: WorkPlanRecord,
  task: EntityRecord,
): WorkPlanRecord {
  return service.stageTask(plan.id, stages(plan)[0]!.id, task.key, false, write(plan));
}

describe("PlanningService: реальная SQLite", () => {
  test("страница обычных планов читает только окно Storage, фильтр сохраняет предметный отбор и total", () => {
    fixture((db, service) => {
      const second = service.create("work-plan", { title: "Бета" }, actor);
      const first = service.create("work-plan", { title: "Альфа" }, actor);
      const release = service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [first.id] },
        actor,
      );
      const fullRead = spyOn(db, "list").mockImplementation(() => {
        throw new Error("Полное чтение обычной страницы запрещено");
      });
      try {
        expect(service.listPage("work-plan", {}, { offset: 0, limit: 1, sort: "title" })).toEqual({
          total: 2,
          items: [first],
        });
        expect(service.listPage("work-plan", {}, { offset: 1, limit: 1, sort: "title" })).toEqual({
          total: 2,
          items: [second],
        });
        expect(service.listPage("release", {}, { offset: 0, limit: 1, sort: "key" })).toEqual({
          total: 1,
          items: [release],
        });
      } finally {
        fullRead.mockRestore();
      }
      expect(
        service.listPage(
          "work-plan",
          { status: "draft", q: "Альфа" },
          { offset: 0, limit: 1, sort: "key" },
        ),
      ).toEqual({ total: 1, items: [first] });
      fails(
        () =>
          service.listPage("work-plan", { status: "banana" }, { offset: 0, limit: 1, sort: "key" }),
        "INVALID_ARGUMENT",
      );
    });
  });

  test("предметные фильтры проверяют статус и ищут содержание этапов и типизированный адрес", () => {
    fixture((db, service) => {
      const draft = planWithStage(service, "Черновик");
      const historical = planWithStage(service, "История");
      const cancelled = service.transition(
        "work-plan",
        historical.id,
        "cancel",
        { result: "Закрыто" },
        write(historical),
      );
      const release = service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [draft.id] },
        actor,
      );
      const generation = db.getGeneration();
      expect(service.list("work-plan", { status: "draft", q: "Полный Markdown" })).toEqual([draft]);
      expect(service.list("work-plan", { q: `work-plan:${cancelled.key}` })).toEqual([cancelled]);
      expect(service.list("release", { status: "planned" })).toEqual([release]);
      for (const [kind, status] of [
        ["work-plan", "banana"],
        ["work-plan", "planned"],
        ["release", "active"],
        ["release", ""],
      ] as const)
        fails(() => service.list(kind, { status }), "INVALID_ARGUMENT");
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("составы Core сохраняют порядок и ревизию владельца, memberships включают закрытые планы", () => {
    fixture((_db, service, tasks) => {
      const task = tasks.create({ title: "Работа" }, actor);
      const first = include(service, planWithStage(service, "Первый"), task);
      const history = service.transition(
        "work-plan",
        first.id,
        "cancel",
        { result: "Пересмотр" },
        write(first),
      );
      const current = include(service, planWithStage(service, "Текущий"), task);
      const stage = stages(current)[0]!;
      const release = service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [current.key] },
        actor,
      );
      expect(service.listStages(current.key)).toEqual({
        plan: current.key,
        revision: current.revision,
        items: stages(current),
      });
      expect(service.getStage(current.id, stage.id)).toEqual({
        plan: current.key,
        revision: current.revision,
        stage,
      });
      expect(service.stageTasks(current.key, stage.id)).toEqual({
        plan: current.key,
        revision: current.revision,
        items: [task],
      });
      expect(service.memberships(task.key)).toEqual({
        task: task.key,
        items: [history, current].map((plan) => ({
          plan: plan.key,
          revision: plan.revision,
          stage: stages(plan)[0]!,
        })),
      });
      expect(service.releasePlans(release.key)).toEqual({
        release: release.key,
        revision: release.revision,
        items: [current],
      });
      fails(() => service.getStage(current.id, "missing"), "NOT_FOUND");
    });
  });

  test("состав этапа и задачи читаются из одного снимка при конкурентной записи после чтения плана", () => {
    fixture((db, service, tasks) => {
      const task = tasks.create({ title: "Работа", description: "До записи" }, actor);
      const plan = include(service, planWithStage(service), task);
      const writer = ProjectDatabase.open(db.path);
      const originalGet = db.get.bind(db);
      let changed = false;
      const get = spyOn(db, "get").mockImplementation((ref, kind) => {
        const record = originalGet(ref, kind);
        if (record?.id === plan.id && !changed) {
          changed = true;
          writer.transaction(() => {
            new PlanningService(writer).update(
              "work-plan",
              plan.id,
              { summary: "После записи" },
              write(plan),
            );
            new TasksService(writer).update(task.id, { description: "После записи" }, write(task));
          });
        }
        return record;
      });
      try {
        expect(service.stageTasks(plan.id, stages(plan)[0]!.id)).toEqual({
          plan: plan.key,
          revision: plan.revision,
          items: [task],
        });
        expect(changed).toBe(true);
      } finally {
        get.mockRestore();
        writer.close();
      }
      expect(service.get("work-plan", plan.id).revision).toBe(plan.revision + 1);
      expect(tasks.get(task.id).data.description).toBe("После записи");
    });
  });

  test.each([
    { name: "null вместо stages", damage: () => null },
    { name: "нестроковый title этапа", damage: (stage: PlanStage) => [{ ...stage, title: 42 }] },
    { name: "null вместо taskIds", damage: (stage: PlanStage) => [{ ...stage, taskIds: null }] },
    {
      name: "нестроковое условие завершения",
      damage: (stage: PlanStage) => [{ ...stage, completionConditions: false }],
    },
  ])("повреждённый $name отвергает чтение и изменение без записи", ({ damage }) => {
    fixture((db, service, tasks) => {
      const task = tasks.create({ title: "Работа" }, actor);
      const plan = include(service, planWithStage(service), task);
      // Намеренно повреждаем сохранённую форму через Storage, обходя предметный API.
      const corrupted = {
        ...plan,
        revision: plan.revision + 1,
        data: { ...plan.data, stages: damage(stages(plan)[0]!) },
      };
      db.update(corrupted, plan.revision);
      const generation = db.getGeneration();
      for (const operation of [
        () => service.get("work-plan", plan.id),
        () => service.list("work-plan"),
        () => service.getStage(plan.id, stages(plan)[0]!.id),
        () => service.memberships(task.id),
        () => service.update("work-plan", plan.id, { summary: "Не сохранять" }, write(corrupted)),
        () => service.stage(plan.id, "create", { title: "Не сохранять" }, write(corrupted)),
      ])
        fails(operation, "CORRUPT_DATA");
      expect(db.get(plan.id)).toEqual(corrupted);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("повреждённый состав релиза не маскируется пустым списком и не допускает обновление", () => {
    fixture((db, service) => {
      const plan = planWithStage(service);
      const release = service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [plan.id] },
        actor,
      );
      // Низкоуровневый fixture моделирует недопустимый сохранённый JSON.
      const corrupted = {
        ...release,
        revision: release.revision + 1,
        data: { ...release.data, planIds: null },
      };
      db.update(corrupted, release.revision);
      const generation = db.getGeneration();
      fails(() => service.releasePlans(release.id), "CORRUPT_DATA");
      fails(() => service.progress("release", release.id), "CORRUPT_DATA");
      fails(
        () => service.update("release", release.id, { title: "Не сохранять" }, write(corrupted)),
        "CORRUPT_DATA",
      );
      expect(db.get(release.id)).toEqual(corrupted);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("progress, complete и publish строят один граф без чтения текстов и журналов задач состава", () => {
    fixture((db, service, tasks) => {
      const descriptionMarker = "НЕ-ЧИТАТЬ-ОПИСАНИЕ-ПРИ-ПРОГРЕССЕ";
      const commentMarker = "НЕ-ЧИТАТЬ-КОММЕНТАРИЙ-ПРИ-ПРОГРЕССЕ";
      const firstTask = tasks.create(
        { title: "Первая", description: descriptionMarker, column: "done" },
        actor,
      );
      const secondTask = tasks.create(
        { title: "Вторая", description: descriptionMarker, column: "done" },
        actor,
      );
      const thirdTask = tasks.create(
        { title: "Третья", description: descriptionMarker, column: "done" },
        actor,
      );
      for (const task of [firstTask, secondTask, thirdTask])
        tasks.comment(task.id, commentMarker, actor);
      let first = include(
        service,
        include(service, planWithStage(service, "Первый"), firstTask),
        secondTask,
      );
      let second = include(service, planWithStage(service, "Второй"), thirdTask);
      const graphReads = spyOn(db, "listTaskGraph");
      const parse = JSON.parse;
      const decoded: string[] = [];
      const decoder = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        decoded.push(text);
        return parse(text, reviver);
      });
      try {
        expect(service.progress("work-plan", first.id)).toMatchObject({
          completed: true,
          counts: { total: 2, completed: 2 },
          blockers: [],
        });
        expect(graphReads).toHaveBeenCalledTimes(1);
        expect(
          decoded.some((text) => text.includes(descriptionMarker) || text.includes(commentMarker)),
        ).toBe(false);
        graphReads.mockClear();
        first = service.transition(
          "work-plan",
          first.id,
          "complete",
          { result: "Готово" },
          write(first),
        );
        expect(first.data.status).toBe("completed");
        expect(graphReads).toHaveBeenCalledTimes(1);
        graphReads.mockClear();
        second = service.transition(
          "work-plan",
          second.id,
          "complete",
          { result: "Готово" },
          write(second),
        );
        expect(graphReads).toHaveBeenCalledTimes(1);
        const release = service.create(
          "release",
          { title: "Выпуск", version: "1", planIds: [first.id, second.id] },
          actor,
        );
        graphReads.mockClear();
        expect(service.progress("release", release.id)).toMatchObject({
          completed: true,
          counts: { total: 2, completed: 2 },
          plans: [
            { id: first.id, completed: true },
            { id: second.id, completed: true },
          ],
          blockers: [],
        });
        expect(graphReads).toHaveBeenCalledTimes(1);
        graphReads.mockClear();
        expect(
          service.transition("release", release.id, "publish", {}, write(release)).data.status,
        ).toBe("released");
        expect(graphReads).toHaveBeenCalledTimes(1);
        expect(
          decoded.some((text) => text.includes(descriptionMarker) || text.includes(commentMarker)),
        ).toBe(false);
      } finally {
        decoder.mockRestore();
        graphReads.mockRestore();
      }
    });
  });

  test("полные тексты, ссылки ID и порядок этапов сохраняются после повторного открытия", () => {
    fixture((db, service, tasks) => {
      const task = tasks.create({ title: "Существующая задача", description: markdown }, actor);
      let plan = service.create(
        "work-plan",
        {
          title: "Перенос",
          summary: "Краткое описание",
          goal: markdown,
          rationale: markdown,
          boundaries: markdown,
          expectedResult: markdown,
          participants: ["Разработчик"],
          scope: [
            { kind: "project", id: "PROJECT" },
            { kind: "product", id: "PRODUCT" },
          ],
        },
        actor,
      );
      expect(plan.data.scope).toEqual([
        { kind: "project", id: db.projectId },
        { kind: "product", id: db.get("PRODUCT")!.id },
      ]);
      plan = service.stage(plan.key, "create", { title: "Первый", outcome: markdown }, write(plan));
      const first = stages(plan)[0]!.id;
      plan = service.stage(plan.id, "create", { title: "Второй", before: first }, write(plan));
      const second = stages(plan)[0]!.id;
      expect(stages(plan).map((stage) => stage.id)).toEqual([second, first]);
      plan = service.stage(plan.id, "move", { stageId: second, direction: "down" }, write(plan));
      expect(stages(plan).map((stage) => stage.id)).toEqual([first, second]);
      plan = service.stage(plan.id, "move", { stageId: first, before: null }, write(plan));
      expect(stages(plan).map((stage) => stage.id)).toEqual([second, first]);
      plan = service.stage(
        plan.id,
        "update",
        { stageId: second, completionConditions: markdown },
        write(plan),
      );
      plan = service.stageTask(plan.id, first, task.key, false, write(plan));
      const generation = db.getGeneration();
      fails(
        () => service.stage(plan.id, "remove", { stageId: first }, write(plan)),
        "STAGE_NOT_EMPTY",
      );
      expect(db.getGeneration()).toBe(generation);
      expect(service.get("work-plan", plan.id)).toEqual(plan);
      plan = service.stage(plan.id, "remove", { stageId: second }, write(plan));
      plan = service.update("work-plan", plan.key, { summary: "Уточнено" }, write(plan));
      const renamedTask = new EntityService(db).rename(
        task.id,
        "task",
        "RENAMED-TASK",
        write(task),
      );
      expect(stages(plan)[0]!.taskIds).toEqual([task.id]);
      expect(tasks.get(task.key).id).toBe(renamedTask.id);
      expect(tasks.get(task.id).data).toEqual(task.data);

      const reopened = ProjectDatabase.open(db.path);
      try {
        const fresh = new PlanningService(reopened);
        expect(fresh.get("work-plan", plan.key)).toEqual(plan);
        expect(fresh.list("work-plan")).toEqual([plan]);
        for (const field of ["goal", "rationale", "boundaries", "expectedResult"] as const)
          expect(plan.data[field]).toBe(markdown);
        expect(stages(plan)[0]!.outcome).toBe(markdown);
        expect(fresh.progress("work-plan", plan.id).completed).toBe(false);
      } finally {
        reopened.close();
      }
    });
  });

  test("только одно текущее включение; отмена сохраняет состав и не меняет задачу", () => {
    fixture((db, service, tasks) => {
      const task = tasks.create({ title: "Общая работа" }, actor);
      let first = include(service, planWithStage(service, "Первый"), task);
      first = service.stage(first.id, "create", { title: "Другой этап" }, write(first));
      let second = planWithStage(service, "Второй");
      const before = db.getGeneration();
      fails(() => include(service, second, task), "MEMBERSHIP_CONFLICT");
      fails(
        () => service.stageTask(first.id, stages(first)[1]!.id, task.id, false, write(first)),
        "MEMBERSHIP_CONFLICT",
      );
      expect(db.getGeneration()).toBe(before);
      expect(service.get("work-plan", first.id)).toEqual(first);
      expect(service.get("work-plan", second.id)).toEqual(second);
      first = service.transition(
        "work-plan",
        first.id,
        "cancel",
        { result: markdown },
        write(first),
      );
      second = include(service, second, task);
      expect(stages(first)[0]!.taskIds).toEqual([task.id]);
      expect(stages(second)[0]!.taskIds).toEqual([task.id]);
      expect(first.data.result).toBe(markdown);
      expect(tasks.get(task.id)).toEqual(task);
      for (const operation of [
        () => service.update("work-plan", first.id, { goal: "Другая цель" }, write(first)),
        () => service.stageTask(first.id, stages(first)[0]!.id, task.id, true, write(first)),
        () => service.stage(first.id, "create", { title: "Поздний этап" }, write(first)),
        () => service.transition("work-plan", first.id, "start", {}, write(first)),
      ])
        fails(operation, "PLAN_READ_ONLY");
    });
  });

  test("устаревшая ревизия отклоняется и для no-op через независимое соединение", () => {
    fixture((db, service, tasks) => {
      const task = tasks.create({ title: "Задача" }, actor);
      const initial = include(service, planWithStage(service), task);
      const connection = ProjectDatabase.open(db.path);
      try {
        const concurrent = new PlanningService(connection);
        const current = concurrent.update(
          "work-plan",
          initial.id,
          { summary: "Другой автор" },
          write(initial),
        );
        const generation = db.getGeneration();
        fails(
          () =>
            service.stageTask(initial.id, stages(initial)[0]!.id, task.id, false, write(initial)),
          "REVISION_CONFLICT",
        );
        fails(
          () =>
            service.stage(
              initial.id,
              "move",
              { stageId: stages(initial)[0]!.id, direction: "up" },
              write(initial),
            ),
          "REVISION_CONFLICT",
        );
        fails(
          () =>
            service.update("work-plan", initial.id, { summary: "Другой автор" }, write(initial)),
          "REVISION_CONFLICT",
        );
        expect(
          service.stageTask(current.id, stages(current)[0]!.id, task.id, false, write(current)),
        ).toEqual(current);
        expect(db.getGeneration()).toBe(generation);
        expect(service.get("work-plan", current.id)).toEqual(current);
      } finally {
        connection.close();
      }
    });
  });

  test("перенос проверяет обе ревизии, а отказ второй SQL-записи откатывает оба плана", () => {
    fixture((db, service, tasks) => {
      const task = tasks.create({ title: "Переносимая работа" }, actor);
      const source = include(service, planWithStage(service, "Источник"), task);
      let target = planWithStage(service, "Получатель");
      const staleTarget = target;
      target = service.update("work-plan", target.id, { summary: "Новая ревизия" }, write(target));
      const input = {
        task: task.key,
        targetPlan: target.key,
        targetStage: stages(target)[0]!.id,
        reason: "Пересмотр объёма",
      };
      const generation = db.getGeneration();
      fails(
        () =>
          service.transfer(source.id, input, {
            ...write(source),
            targetRevision: staleTarget.revision,
          }),
        "REVISION_CONFLICT",
      );
      fails(
        () =>
          service.transfer(source.id, input, {
            ...write(source),
            ifRevision: source.revision - 1,
            targetRevision: target.revision,
          }),
        "REVISION_CONFLICT",
      );
      expect(service.get("work-plan", source.id)).toEqual(source);
      expect(service.get("work-plan", target.id)).toEqual(target);
      expect(db.getGeneration()).toBe(generation);

      const sql = new Database(db.path, { create: false, readwrite: true });
      try {
        // Триггер моделирует реальный отказ хранения после успешной первой UPDATE.
        sql.exec(`CREATE TRIGGER reject_transfer BEFORE UPDATE ON entities
          WHEN OLD.id = '${target.id}' BEGIN SELECT RAISE(ABORT, 'Отказ второй записи'); END`);
        expect(() =>
          service.transfer(source.id, input, { ...write(source), targetRevision: target.revision }),
        ).toThrow();
        expect(service.get("work-plan", source.id)).toEqual(source);
        expect(service.get("work-plan", target.id)).toEqual(target);
        expect(db.getGeneration()).toBe(generation);
        sql.exec("DROP TRIGGER reject_transfer");
      } finally {
        sql.close();
      }

      const saved = service.transfer(source.id, input, {
        ...write(source),
        targetRevision: target.revision,
      });
      expect(stages(saved.source)[0]!.taskIds).toEqual([]);
      expect(stages(saved.target)[0]!.taskIds).toEqual([task.id]);
      expect(saved.source.revision).toBe(source.revision + 1);
      expect(saved.target.revision).toBe(target.revision + 1);
      expect(tasks.get(task.id)).toEqual(task);
    });
  });

  test("перенос между этапами одного плана сохраняет одну ревизию и не теряет задачу", () => {
    fixture((db, service, tasks) => {
      const task = tasks.create({ title: "Задача" }, actor);
      let plan = include(service, planWithStage(service), task);
      plan = service.stage(plan.id, "create", { title: "Получатель" }, write(plan));
      const input = {
        task: task.id,
        targetPlan: plan.id,
        targetStage: stages(plan)[1]!.id,
        reason: "Уточнён порядок",
      };
      const options = { ...write(plan), targetRevision: plan.revision };
      fails(
        () => service.transfer(plan.id, input, { ...options, targetRevision: plan.revision - 1 }),
        "REVISION_CONFLICT",
      );
      fails(
        () => service.transfer(plan.id, { ...input, reason: "  " }, options),
        "VALIDATION_ERROR",
      );
      const saved = service.transfer(plan.id, input, options);
      expect(saved.source).toEqual(saved.target);
      expect(saved.target.revision).toBe(plan.revision + 1);
      expect(stages(saved.target).map((stage) => stage.taskIds)).toEqual([[], [task.id]]);
      const generation = db.getGeneration();
      expect(
        service.transfer(plan.id, input, {
          ...write(saved.target),
          targetRevision: saved.target.revision,
        }).target,
      ).toEqual(saved.target);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("начало требует цели и состава, пустой план нельзя завершить", () => {
    fixture((_db, service, tasks) => {
      let plan = service.create("work-plan", { title: "Черновик" }, actor);
      fails(() => service.transition("work-plan", plan.id, "start", {}, write(plan)), "NOT_READY");
      fails(
        () =>
          service.transition("work-plan", plan.id, "complete", { result: markdown }, write(plan)),
        "NOT_READY",
      );
      expect(service.progress("work-plan", plan.id)).toMatchObject({
        completed: false,
        counts: { total: 0, completed: 0, percent: 0 },
      });
      plan = service.stage(plan.id, "create", { title: "Этап" }, write(plan));
      const task = tasks.create({ title: "Работа" }, actor);
      plan = include(service, plan, task);
      fails(() => service.transition("work-plan", plan.id, "start", {}, write(plan)), "NOT_READY");
      plan = service.update("work-plan", plan.id, { goal: markdown }, write(plan));
      plan = service.transition("work-plan", plan.id, "start", {}, write(plan));
      expect(plan.data.status).toBe("active");
      expect(plan.data.startedAt).toBeString();
      expect(tasks.get(task.id)).toEqual(task);
      fails(
        () => service.transition("work-plan", plan.id, "cancel", { result: "\n " }, write(plan)),
        "VALIDATION_ERROR",
      );
    });
  });

  test("готовность задачи к закрытию и выполненные критерии ещё не означают выполнение плана", () => {
    fixture((_db, service, tasks) => {
      let task = tasks.create(
        {
          title: "Работа с критерием",
          acceptanceCriteria: [{ title: "Проверено внешним инструментом" }],
        },
        actor,
      );
      const plan = include(service, planWithStage(service), task);
      fails(
        () =>
          service.transition("work-plan", plan.id, "complete", { result: markdown }, write(plan)),
        "NOT_READY",
      );
      const criterionId = (task.data.acceptanceCriteria as Array<{ id: string }>)[0]!.id;
      task = tasks.criterion(task.id, "complete", { id: criterionId }, write(task));
      task = tasks.move(task.id, { column: "review" }, write(task));
      expect(tasks.progress(task.id)).toMatchObject({ completed: false, canComplete: true });
      expect(service.progress("work-plan", plan.id).completed).toBe(false);
      fails(
        () =>
          service.transition("work-plan", plan.id, "complete", { result: markdown }, write(plan)),
        "NOT_READY",
      );
      tasks.move(task.id, { column: "done" }, write(task));
      expect(service.progress("work-plan", plan.id).completed).toBe(true);
    });
  });

  test("done без актуальных зависимостей и детей не завершает план; пустой этап не блокирует", () => {
    fixture((db, service, tasks) => {
      let dependency = tasks.create({ title: "Внешняя зависимость", column: "done" }, actor);
      let parent = tasks.create(
        { title: "Собственная задача", dependencies: [dependency.id] },
        actor,
      );
      let child = tasks.create(
        { title: "Дочерняя работа", parent: parent.id, column: "done" },
        actor,
      );
      parent = tasks.move(parent.id, { column: "done" }, write(parent));
      let plan = include(service, planWithStage(service), parent);
      plan = service.stage(plan.id, "create", { title: "Пустой этап" }, write(plan));
      dependency = tasks.move(dependency.id, { column: "ready" }, write(dependency));
      const before = db.getGeneration();
      expect(service.progress("work-plan", plan.id)).toMatchObject({
        completed: false,
        counts: { total: 1, completed: 0 },
      });
      expect(service.progress("work-plan", plan.id).blockers).toContain(dependency.id);
      fails(
        () =>
          service.transition("work-plan", plan.id, "complete", { result: markdown }, write(plan)),
        "NOT_READY",
      );
      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(before);
      dependency = tasks.move(dependency.id, { column: "done" }, write(dependency));
      child = tasks.move(child.id, { column: "in-progress" }, write(child));
      fails(
        () =>
          service.transition("work-plan", plan.id, "complete", { result: markdown }, write(plan)),
        "NOT_READY",
      );
      child = tasks.move(child.id, { column: "done" }, write(child));
      const ready = service.progress("work-plan", plan.id);
      expect(ready).toMatchObject({
        completed: true,
        counts: { total: 1, completed: 1, percent: 100 },
      });
      expect(ready.stages).toMatchObject([{ completed: true }, { completed: false }]);
      expect(plan.data.status).toBe("draft");
      plan = service.transition(
        "work-plan",
        plan.id,
        "complete",
        { result: markdown },
        write(plan),
      );
      expect(plan.data.status).toBe("completed");
      expect(plan.data.startedAt).toBeNull();
      expect(plan.data.result).toBe(markdown);
      expect(plan.data.closedAt).toBeString();
      fails(
        () => service.update("work-plan", plan.id, { summary: "Нельзя" }, write(plan)),
        "PLAN_READ_ONLY",
      );
      const next = include(service, planWithStage(service, "Следующий план"), parent);
      expect(stages(next)[0]!.taskIds).toEqual([parent.id]);
      expect(stages(service.get("work-plan", plan.id))[0]!.taskIds).toEqual([parent.id]);
    });
  });

  test("релиз проверяет все completed-планы и повторное открытие задач; выпущенная запись неизменяема", () => {
    fixture((db, service, tasks) => {
      let task = tasks.create({ title: "Первая работа", column: "done" }, actor);
      const otherTask = tasks.create({ title: "Вторая работа", column: "done" }, actor);
      let first = include(service, planWithStage(service, "Первый"), task);
      let second = include(service, planWithStage(service, "Второй"), otherTask);
      first = service.transition(
        "work-plan",
        first.id,
        "complete",
        { result: markdown },
        write(first),
      );
      let release = service.create(
        "release",
        {
          title: "Выпуск",
          version: "1.0",
          planIds: [first.key, second.id],
          description: markdown,
          summary: "Кратко",
          plannedFor: "2026-10-20",
        },
        actor,
      );
      expect(release.data.planIds).toEqual([first.id, second.id]);
      expect(release.data.projectId).toBe(db.projectId);
      expect(release.data.description).toBe(markdown);
      expect(release.data).not.toHaveProperty("applicationId");
      fails(
        () => service.transition("release", release.id, "publish", {}, write(release)),
        "NOT_READY",
      );
      expect(service.progress("release", release.id)).toMatchObject({
        completed: false,
        counts: { total: 2, completed: 1 },
      });
      second = service.transition(
        "work-plan",
        second.id,
        "complete",
        { result: "Выполнено" },
        write(second),
      );
      expect(service.progress("release", release.id).completed).toBe(true);
      expect(service.get("release", release.id).data.status).toBe("planned");
      task = tasks.move(task.id, { column: "in-progress" }, write(task));
      const generation = db.getGeneration();
      fails(
        () => service.transition("release", release.id, "publish", {}, write(release)),
        "NOT_READY",
      );
      expect(service.get("release", release.id)).toEqual(release);
      expect(service.get("work-plan", first.id)).toEqual(first);
      expect(service.progress("work-plan", first.id).completed).toBe(false);
      expect(db.getGeneration()).toBe(generation);
      task = tasks.move(task.id, { column: "done" }, write(task));
      release = service.transition(
        "release",
        release.id,
        "publish",
        {},
        { ...write(release), actor: "publisher" },
      );
      expect(release.data.status).toBe("released");
      expect(release.data.releasedAt).toBeString();
      expect(release.data.releasedBy).toBe("publisher");
      expect(service.get("work-plan", second.id)).toEqual(second);
      for (const action of ["plan", "cancel", "publish"]) {
        fails(
          () => service.transition("release", release.id, action, {}, write(release)),
          "RELEASE_READ_ONLY",
        );
      }
      fails(
        () => service.update("release", release.id, { version: "2.0" }, write(release)),
        "RELEASE_READ_ONLY",
      );
      tasks.move(task.id, { column: "ready" }, write(task));
      const afterReopen = db.getGeneration();
      expect(service.progress("release", release.id).completed).toBe(false);
      expect(service.get("release", release.id)).toEqual(release);
      expect(db.getGeneration()).toBe(afterReopen);
      expect(service.list("release")).toEqual([release]);
    });
  });

  test("отменённый релиз перепланируется только явным действием, версии могут повторяться", () => {
    fixture((_db, service) => {
      const plan = planWithStage(service);
      let release = service.create(
        "release",
        { title: "Выпуск", version: "1.0", planIds: [plan.id] },
        actor,
      );
      service.create(
        "release",
        { title: "Другой выпуск", version: "1.0", planIds: [plan.key] },
        actor,
      );
      release = service.transition("release", release.id, "cancel", {}, write(release));
      release = service.update("release", release.id, { description: markdown }, write(release));
      expect(release.data.status).toBe("cancelled");
      expect(service.get("work-plan", plan.id)).toEqual(plan);
      fails(
        () => service.transition("release", release.id, "publish", {}, write(release)),
        "INVALID_TRANSITION",
      );
      const cancelled = release;
      release = service.transition("release", release.id, "plan", {}, write(release));
      expect(release.data.status).toBe("planned");
      fails(
        () => service.transition("release", release.id, "plan", {}, write(cancelled)),
        "REVISION_CONFLICT",
      );
      expect(service.transition("release", release.id, "plan", {}, write(release))).toEqual(
        release,
      );
    });
  });

  test("строгий ввод не допускает обход статусов, чужую область релиза или дубли ссылок", () => {
    fixture((db, service) => {
      const plan = planWithStage(service);
      const before = db.getGeneration();
      for (const input of [
        { title: "План", status: "completed" },
        { title: "План", stages: [] },
        { title: "План", result: "Готово" },
        { title: "План", goal: null },
        { title: "План", summary: undefined },
        { title: " \n" },
        { title: "План", scope: [{ kind: "task", id: "PRODUCT" }] },
        {
          title: "План",
          scope: [
            { kind: "project", id: "PROJECT" },
            { kind: "project", id: db.projectId },
          ],
        },
        { title: "План", participants: ["Агент", "Агент"] },
      ])
        fails(() => service.create("work-plan", input, actor), "VALIDATION_ERROR");
      for (const fields of [
        { applicationId: "application" },
        { planIds: [] },
        { planIds: [plan.id, plan.key] },
        { plannedFor: "2026-02-30" },
        { version: "" },
        { status: "released" },
        { planIds: Array.from({ length: 201 }, () => plan.id) },
      ])
        fails(
          () =>
            service.create(
              "release",
              { title: "Выпуск", version: "1", planIds: [plan.id], ...fields },
              actor,
            ),
          "VALIDATION_ERROR",
        );
      fails(
        () =>
          service.create("release", { title: "Выпуск", version: "1", planIds: ["MISSING"] }, actor),
        "NOT_FOUND",
      );
      fails(
        () =>
          service.stage(
            plan.id,
            "update",
            { stageId: stages(plan)[0]!.id, taskIds: [] },
            write(plan),
          ),
        "VALIDATION_ERROR",
      );
      fails(
        () =>
          service.stage(
            plan.id,
            "move",
            { stageId: stages(plan)[0]!.id, before: null, direction: "up" },
            write(plan),
          ),
        "VALIDATION_ERROR",
      );
      fails(
        () => service.update("work-plan", plan.id, { title: "Изменено" }, { actor, ifRevision: 0 }),
        "VALIDATION_ERROR",
      );
      expect(db.getGeneration()).toBe(before);
      expect(service.get("work-plan", plan.id)).toEqual(plan);
      const cancelled = service.transition(
        "work-plan",
        plan.id,
        "cancel",
        { result: "Не нужно" },
        write(plan),
      );
      fails(
        () =>
          service.create(
            "release",
            { title: "Выпуск", version: "1", planIds: [cancelled.id] },
            actor,
          ),
        "INVALID_PLAN",
      );
    });
  });

  test.each(["planIds", "scope", "participants"] as const)(
    "разреженный %s отклоняется при create/update без изменения данных, ревизий и поколения",
    (field) => {
      fixture((db, service) => {
        const plan = planWithStage(service);
        const kind = field === "planIds" ? "release" : "work-plan";
        const creation =
          kind === "release"
            ? { title: "Выпуск", version: "1", planIds: [plan.id] }
            : { title: "План" };
        const current = kind === "release" ? service.create(kind, creation, actor) : plan;
        const records = db.list();
        const generation = db.getGeneration();
        const partial = new Array<unknown>(2);
        partial[0] =
          field === "planIds"
            ? plan.id
            : field === "scope"
              ? { kind: "project", id: "PROJECT" }
              : actor;

        for (const sparse of [new Array<unknown>(1), partial]) {
          for (const operation of [
            () => service.create(kind, { ...creation, [field]: sparse }, actor),
            () =>
              service.update(
                kind,
                current.id,
                { summary: "Не сохранять", [field]: sparse },
                write(current),
              ),
          ]) {
            fails(operation, "VALIDATION_ERROR");
            expect(db.list()).toEqual(records);
            expect(service.get(kind, current.id)).toEqual(current);
            expect(db.getGeneration()).toBe(generation);
          }
        }

        expect(service.progress(kind, current.id).completed).toBe(false);
        const updated = service.update(
          kind,
          current.id,
          { title: "Допустимое изменение" },
          write(current),
        );
        expect(updated.revision).toBe(current.revision + 1);
        expect(updated.data).toEqual({ ...current.data, title: "Допустимое изменение" });
      });
    },
  );

  test("повреждённая ссылка не превращается в готовый или пустой состав", () => {
    fixture((db, service) => {
      const initial = planWithStage(service);
      // Намеренная битая ссылка сохраняется низкоуровневым fixture Storage.
      const plan = {
        ...initial,
        revision: initial.revision + 1,
        data: {
          ...initial.data,
          stages: stages(initial).map((stage) => ({ ...stage, taskIds: ["missing-task-id"] })),
        },
      };
      db.update(plan, initial.revision);
      const release = service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [plan.id] },
        actor,
      );
      const before = db.getGeneration();
      fails(() => service.progress("work-plan", plan.id), "NOT_FOUND");
      fails(() => service.progress("release", release.id), "NOT_FOUND");
      fails(
        () =>
          service.transition("work-plan", plan.id, "complete", { result: "Готово" }, write(plan)),
        "NOT_FOUND",
      );
      expect(db.getGeneration()).toBe(before);
      expect(service.get("work-plan", plan.id)).toEqual(plan);
    });
  });
});
