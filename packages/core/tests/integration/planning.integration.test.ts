import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RelayError,
  type EntityRecord,
  type PlanStage,
  type ReleaseRecord,
  type TaskRecord,
  type WorkPlanRecord,
  type WriteOptions,
} from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../../src/entities/entities";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import type { CompletedPlanRelease } from "./helpers/planning-fixture.types";

const actor = "planning-test";
const markdown = "\n# Полный Markdown\n\n- **Результат**\n\n```ts\nconst answer = 42;\n```\n";
const descriptionMarker = "НЕ-ЧИТАТЬ-ОПИСАНИЕ-ПРИ-ПРОГРЕССЕ";
const commentMarker = "НЕ-ЧИТАТЬ-КОММЕНТАРИЙ-ПРИ-ПРОГРЕССЕ";
const completedPlanSizes = [
  { name: "одной задачей", count: 1 },
  { name: "двумя задачами", count: 2 },
] as const;

const invalidStatuses = [
  { name: "неизвестный статус плана", kind: "work-plan", status: "banana" },
  { name: "статус релиза у плана", kind: "work-plan", status: "planned" },
  { name: "статус плана у релиза", kind: "release", status: "active" },
  { name: "пустой статус релиза", kind: "release", status: "" },
] as const;

const invalidPlanInputs = [
  { name: "прямое назначение статуса", input: { title: "План", status: "completed" } },
  { name: "прямая запись этапов", input: { title: "План", stages: [] } },
  { name: "прямая запись результата", input: { title: "План", result: "Готово" } },
  { name: "null вместо цели", input: { title: "План", goal: null } },
  { name: "явный undefined в summary", input: { title: "План", summary: undefined } },
  { name: "пробельный заголовок", input: { title: " \n" } },
  {
    name: "недопустимый вид области",
    input: { title: "План", scope: [{ kind: "task", id: "PRODUCT" }] },
  },
  { name: "повтор участника", input: { title: "План", participants: ["Агент", "Агент"] } },
] as const;

const invalidReleaseFields = [
  { name: "область отдельного приложения", input: { applicationId: "application" } },
  { name: "пустой состав", input: { planIds: [] } },
  { name: "несуществующая календарная дата", input: { plannedFor: "2026-02-30" } },
  { name: "пустая версия", input: { version: "" } },
  { name: "прямое назначение статуса", input: { status: "released" } },
] as const;

const corruptedStageVariants = [
  {
    damageName: "null вместо stages",
    /**
     * Подменяет массив этапов недопустимым null.
     */
    damage: (): unknown => null,
  },
  {
    damageName: "нестроковый title этапа",
    /**
     * Повреждает заголовок существующего этапа, сохраняя его связи.
     */
    damage: (stage: PlanStage): unknown => [{ ...stage, title: 42 }],
  },
  {
    damageName: "null вместо taskIds",
    /**
     * Подменяет явный состав этапа недопустимым null.
     */
    damage: (stage: PlanStage): unknown => [{ ...stage, taskIds: null }],
  },
  {
    damageName: "нестроковое условие завершения",
    /**
     * Повреждает текст условия завершения существующего этапа.
     */
    damage: (stage: PlanStage): unknown => [{ ...stage, completionConditions: false }],
  },
] as const;

const corruptedPlanOperations = [
  {
    operationName: "чтение плана",
    /**
     * Читает повреждённую карточку целиком.
     */
    run: (service: PlanningService, plan: WorkPlanRecord): unknown =>
      service.get("work-plan", plan.id),
  },
  {
    operationName: "список планов",
    /**
     * Читает список, содержащий повреждённый план.
     */
    run: (service: PlanningService): unknown => service.list("work-plan"),
  },
  {
    operationName: "чтение этапа",
    /**
     * Запрашивает существующий до повреждения этап.
     */
    run: (service: PlanningService, plan: WorkPlanRecord): unknown =>
      service.getStage(plan.id, stageAt(plan).id),
  },
  {
    operationName: "чтение включений задачи",
    /**
     * Запрашивает включения задачи в повреждённый план.
     */
    run: (
      service: PlanningService,
      _plan: WorkPlanRecord,
      _corrupted: EntityRecord,
      task: TaskRecord,
    ): unknown => service.memberships(task.id),
  },
  {
    operationName: "изменение плана",
    /**
     * Пытается изменить текст с актуальной ревизией повреждённой записи.
     */
    run: (service: PlanningService, plan: WorkPlanRecord, corrupted: EntityRecord): unknown =>
      service.update("work-plan", plan.id, { summary: "Не сохранять" }, write(corrupted)),
  },
  {
    operationName: "создание этапа",
    /**
     * Пытается дополнить повреждённый состав этапов.
     */
    run: (service: PlanningService, plan: WorkPlanRecord, corrupted: EntityRecord): unknown =>
      service.stage(plan.id, "create", { title: "Не сохранять" }, write(corrupted)),
  },
] as const;

const corruptedPlanCases = corruptedStageVariants.flatMap((variant) =>
  corruptedPlanOperations.map((operation) => ({ ...variant, ...operation })),
);

const closedPlanOperations = [
  {
    name: "изменение цели",
    /**
     * Пытается изменить текст закрытого плана.
     */
    run: (service: PlanningService, plan: WorkPlanRecord, _task: TaskRecord): unknown =>
      service.update("work-plan", plan.id, { goal: "Другая цель" }, write(plan)),
  },
  {
    name: "исключение задачи",
    /**
     * Пытается удалить историческое включение задачи.
     */
    run: (service: PlanningService, plan: WorkPlanRecord, task: TaskRecord): unknown =>
      service.stageTask(plan.id, stageAt(plan).id, task.id, true, write(plan)),
  },
  {
    name: "создание этапа",
    /**
     * Пытается дополнить состав закрытого плана.
     */
    run: (service: PlanningService, plan: WorkPlanRecord): unknown =>
      service.stage(plan.id, "create", { title: "Поздний этап" }, write(plan)),
  },
  {
    name: "повторное начало",
    /**
     * Пытается снова начать закрытый план.
     */
    run: (service: PlanningService, plan: WorkPlanRecord): unknown =>
      service.transition("work-plan", plan.id, "start", {}, write(plan)),
  },
] as const;

const stalePlanOperations = [
  {
    name: "повторное включение задачи",
    /**
     * Повторяет существующее включение с исходной ревизией плана.
     */
    run: (service: PlanningService, plan: WorkPlanRecord, task: TaskRecord): unknown =>
      service.stageTask(plan.id, stageAt(plan).id, task.id, false, write(plan)),
  },
  {
    name: "перемещение этапа за край",
    /**
     * Запрашивает no-op порядка этапов с исходной ревизией плана.
     */
    run: (service: PlanningService, plan: WorkPlanRecord): unknown =>
      service.stage(plan.id, "move", { stageId: stageAt(plan).id, direction: "up" }, write(plan)),
  },
  {
    name: "неизменный текст",
    /**
     * Передаёт актуальный текст с исходной ревизией плана.
     */
    run: (service: PlanningService, plan: WorkPlanRecord): unknown =>
      service.update("work-plan", plan.id, { summary: "Другой автор" }, write(plan)),
  },
] as const;

const sparseFields = [
  { name: "состав релиза", field: "planIds", kind: "release" },
  { name: "область плана", field: "scope", kind: "work-plan" },
  { name: "участники плана", field: "participants", kind: "work-plan" },
] as const;
const sparseShapes = [
  { shape: "полностью разреженный", hasFirst: false },
  { shape: "с пропуском после первого элемента", hasFirst: true },
] as const;
const sparseActions = [
  { action: "create", actionName: "создание" },
  { action: "update", actionName: "изменение" },
] as const;
const sparseInputCases = sparseFields.flatMap((field) =>
  sparseShapes.flatMap((shape) =>
    sparseActions.map((action) => ({ ...field, ...shape, ...action })),
  ),
);

const membershipTargets = [
  { name: "другой план", target: "plan" },
  { name: "другой этап текущего плана", target: "stage" },
] as const;

const staleTransferOwners = [
  { name: "плана-источника", owner: "source" },
  { name: "плана-получателя", owner: "target" },
] as const;

const releaseReadOnlyActions = [
  { name: "перепланирование", action: "plan" },
  { name: "отмена", action: "cancel" },
  { name: "повторная публикация", action: "publish" },
] as const;

const invalidSamePlanTransfers = [
  {
    name: "устаревшая ревизия получателя",
    reason: "Уточнён порядок",
    targetRevisionDelta: -1,
    code: "REVISION_CONFLICT",
  },
  {
    name: "пробельная причина",
    reason: "  ",
    targetRevisionDelta: 0,
    code: "VALIDATION_ERROR",
  },
] as const;

const corruptedReleaseOperations = [
  {
    name: "чтение состава",
    /**
     * Читает планы релиза с повреждённым сохранённым составом.
     */
    run: (service: PlanningService, release: EntityRecord): unknown =>
      service.releasePlans(release.id),
  },
  {
    name: "расчёт прогресса",
    /**
     * Рассчитывает прогресс релиза с повреждённым сохранённым составом.
     */
    run: (service: PlanningService, release: EntityRecord): unknown =>
      service.progress("release", release.id),
  },
  {
    name: "изменение заголовка",
    /**
     * Пытается изменить релиз с актуальной ревизией повреждённой записи.
     */
    run: (service: PlanningService, release: EntityRecord): unknown =>
      service.update("release", release.id, { title: "Не сохранять" }, write(release)),
  },
] as const;

const brokenCompositionOperations = [
  {
    name: "прогресс плана",
    /**
     * Запрашивает прогресс плана с отсутствующей задачей состава.
     */
    run: (service: PlanningService, plan: WorkPlanRecord, _release: ReleaseRecord): unknown =>
      service.progress("work-plan", plan.id),
  },
  {
    name: "прогресс релиза",
    /**
     * Запрашивает прогресс релиза, план которого ссылается на отсутствующую задачу.
     */
    run: (service: PlanningService, _plan: WorkPlanRecord, release: ReleaseRecord): unknown =>
      service.progress("release", release.id),
  },
  {
    name: "завершение плана",
    /**
     * Пытается завершить план с отсутствующим обязательством.
     */
    run: (service: PlanningService, plan: WorkPlanRecord): unknown =>
      service.transition("work-plan", plan.id, "complete", { result: "Готово" }, write(plan)),
  },
] as const;

/**
 * Передаёт ревизию указанного владельца записи без перечитывания CAS.
 */
function write(record: EntityRecord): WriteOptions {
  return { actor, ifRevision: record.revision };
}

/**
 * Возвращает этап по позиции; неполный fixture немедленно завершает тест ошибкой.
 */
function stageAt(record: WorkPlanRecord, index = 0): PlanStage {
  const stage = record.data.stages[index];
  if (!stage) {
    throw new Error(`В подготовленном плане отсутствует этап ${index}`);
  }
  return stage;
}

/**
 * Проверяет предметный тип и код отказа, возвращая ошибку для дополнительных утверждений.
 * Сохранность записей остаётся видна в тесте.
 */
async function fails(operation: () => unknown, code: string): Promise<RelayError> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RelayError);
  if (!(error instanceof RelayError)) {
    throw new Error("Ожидалась предметная ошибка Relay", { cause: error });
  }
  expect(error).toMatchObject({ code });
  return error;
}

/**
 * Создаёт отдельный пустой проект в файловой SQLite и очищает его после сценария,
 * включая отказ. Дополнительные соединения закрывает вызывающий тест.
 */
async function fixture(
  operation: (db: ProjectDatabase, service: PlanningService, tasks: TasksService) => Promise<void>,
): Promise<void> {
  const root = fileURLToPath(new URL("../../../../.artifacts/", import.meta.url));
  const parent = join(
    root,
    new Date().toISOString().slice(0, 10),
    "git-sync-implementation/commands/planning",
  );
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "planning-integration-"));
  let db: ProjectDatabase | undefined;
  try {
    db = ProjectDatabase.create(join(directory, "project.sqlite"), {
      id: crypto.randomUUID(),
      name: "Планирование",
      slug: "planning",
    });
    await operation(db, new PlanningService(db), new TasksService(db));
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Создаёт черновик с целью и одним пустым этапом, сохраняя полные Markdown-тексты.
 */
async function planWithStage(service: PlanningService, title = "План"): Promise<WorkPlanRecord> {
  const plan = await service.create("work-plan", { title, goal: markdown }, actor);
  return await service.stage(
    plan.id,
    "create",
    { title: "Этап", outcome: markdown, completionConditions: markdown },
    write(plan),
  );
}

/**
 * Включает задачу в первый этап по ревизии переданного плана и возвращает новую запись.
 */
async function include(
  service: PlanningService,
  plan: WorkPlanRecord,
  task: EntityRecord,
): Promise<WorkPlanRecord> {
  return await service.stageTask(plan.id, stageAt(plan).id, task.key, false, write(plan));
}

/**
 * Создаёт минимальный выпущенный релиз: одна готовая задача, завершённый план и выпуск.
 * Ревизии передаются явно на каждом шаге, последующих скрытых изменений нет.
 */
async function publishedRelease(
  service: PlanningService,
  tasks: TasksService,
): Promise<ReleaseRecord> {
  const task = await tasks.create({ title: "Готовая работа", column: "done" }, actor);
  const initialPlan = await include(service, await planWithStage(service), task);
  const plan = await service.transition(
    "work-plan",
    initialPlan.id,
    "complete",
    { result: markdown },
    write(initialPlan),
  );
  const release = await service.create(
    "release",
    { title: "Выпуск", version: "1", planIds: [plan.id] },
    actor,
  );
  return await service.transition("release", release.id, "publish", {}, write(release));
}

/**
 * Создаёт открытый план с указанным числом готовых задач. Маркеры в описаниях и
 * комментариях позволяют обнаружить лишнее декодирование полных карточек.
 */
async function planWithCompletedTasks(
  service: PlanningService,
  tasks: TasksService,
  title: string,
  count: number,
): Promise<WorkPlanRecord> {
  let plan = await planWithStage(service, title);
  for (let index = 0; index < count; index++) {
    const task = await tasks.create(
      { title: `${title}: работа ${index + 1}`, description: descriptionMarker, column: "done" },
      actor,
    );
    await tasks.comment(task.id, commentMarker, actor);
    plan = await include(service, plan, task);
  }
  return plan;
}

/**
 * Подготавливает два завершённых плана с текстовыми маркерами и запланированный релиз.
 * Подготовка выполняется до перехвата чтений графа, чтобы измерять только действие теста.
 */
async function releaseWithCompletedPlans(
  service: PlanningService,
  tasks: TasksService,
): Promise<CompletedPlanRelease> {
  let first = await planWithCompletedTasks(service, tasks, "Первый", 2);
  let second = await planWithCompletedTasks(service, tasks, "Второй", 1);
  first = await service.transition(
    "work-plan",
    first.id,
    "complete",
    { result: "Готово" },
    write(first),
  );
  second = await service.transition(
    "work-plan",
    second.id,
    "complete",
    { result: "Готово" },
    write(second),
  );
  const release = await service.create(
    "release",
    {
      title: "Выпуск",
      version: "1",
      planIds: [first.id, second.id],
    },
    actor,
  );
  return { first, second, release };
}

/**
 * Проверяет одно чтение графа и отсутствие декодирования текстов и комментариев задач
 * в sync чтении либо async команде. Дожидается результата до восстановления перехватов.
 */
async function expectSingleGraphRead<T>(
  db: ProjectDatabase,
  operation: () => T | Promise<T>,
): Promise<T> {
  const graphReads = spyOn(db, "listTaskGraph");
  const commandReads = spyOn(db.commands, "load");
  const parse = JSON.parse;
  const decoded: string[] = [];
  const decoder = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    decoded.push(text);
    return parse(text, reviver);
  });
  try {
    const result = await operation();

    expect(
      graphReads.mock.calls.length +
        commandReads.mock.calls.flatMap(([request]) =>
          request.selectors.filter((selector) => selector.kind === "task-graph"),
        ).length,
    ).toBe(1);
    expect(
      decoded.some((text) => text.includes(descriptionMarker) || text.includes(commentMarker)),
    ).toBe(false);
    return result;
  } finally {
    decoder.mockRestore();
    graphReads.mockRestore();
    commandReads.mockRestore();
  }
}

describe("Чтение планов и релизов в SQLite", () => {
  test("обычные страницы планов и релизов читают окно Storage с полным total", async () => {
    await fixture(async (db, service) => {
      const second = await service.create("work-plan", { title: "Бета" }, actor);
      const first = await service.create("work-plan", { title: "Альфа" }, actor);
      const release = await service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [first.id] },
        actor,
      );
      const fullRead = spyOn(db, "list").mockImplementation(() => {
        throw new Error("Полное чтение обычной страницы запрещено");
      });
      const pageRead = spyOn(db, "listPage");
      try {
        const firstPage = service.listPage("work-plan", {}, { offset: 0, limit: 1, sort: "title" });
        const secondPage = service.listPage(
          "work-plan",
          {},
          { offset: 1, limit: 1, sort: "title" },
        );
        const releasePage = service.listPage("release", {}, { offset: 0, limit: 1, sort: "key" });

        expect(firstPage).toEqual({
          total: 2,
          items: [first],
        });
        expect(secondPage).toEqual({
          total: 2,
          items: [second],
        });
        expect(releasePage).toEqual({
          total: 1,
          items: [release],
        });
        expect(pageRead).toHaveBeenCalledTimes(3);
        expect(pageRead).toHaveBeenCalledWith("work-plan", { offset: 0, limit: 1, sort: "title" });
        expect(pageRead).toHaveBeenCalledWith("work-plan", { offset: 1, limit: 1, sort: "title" });
        expect(pageRead).toHaveBeenCalledWith("release", { offset: 0, limit: 1, sort: "key" });
      } finally {
        pageRead.mockRestore();
        fullRead.mockRestore();
      }
    });
  });

  test("фильтр плана применяется до окна и сохраняет total отобранного состава", async () => {
    await fixture(async (_db, service) => {
      await service.create("work-plan", { title: "Бета" }, actor);
      const first = await service.create("work-plan", { title: "Альфа" }, actor);

      const page = service.listPage(
        "work-plan",
        { status: "draft", q: "Альфа" },
        { offset: 0, limit: 1, sort: "key" },
      );

      expect(page).toEqual({ total: 1, items: [first] });
    });
  });

  test("неизвестный статус отклоняется при чтении страницы плана", async () => {
    await fixture(async (_db, service) => {
      await fails(
        async () =>
          service.listPage("work-plan", { status: "banana" }, { offset: 0, limit: 1, sort: "key" }),
        "INVALID_ARGUMENT",
      );
    });
  });

  test("поиск по содержанию этапа учитывает статус плана", async () => {
    await fixture(async (_db, service) => {
      const initial = await service.create("work-plan", { title: "Черновик" }, actor);
      const draft = await service.stage(
        initial.id,
        "create",
        { title: "Этап", outcome: "Полный Markdown" },
        write(initial),
      );
      const historical = await planWithStage(service, "История");
      await service.transition(
        "work-plan",
        historical.id,
        "cancel",
        { result: "Закрыто" },
        write(historical),
      );

      const byContent = service.list("work-plan", { status: "draft", q: "Полный Markdown" });

      expect(byContent).toEqual([draft]);
    });
  });

  test("поиск по типизированному адресу находит закрытый план", async () => {
    await fixture(async (_db, service) => {
      const historical = await service.create("work-plan", { title: "История" }, actor);
      const cancelled = await service.transition(
        "work-plan",
        historical.id,
        "cancel",
        { result: "Закрыто" },
        write(historical),
      );

      const byAddress = service.list("work-plan", { q: `work-plan:${cancelled.key}` });

      expect(byAddress).toEqual([cancelled]);
    });
  });

  test("фильтр planned возвращает запланированный релиз", async () => {
    await fixture(async (_db, service) => {
      const draft = await service.create("work-plan", { title: "План" }, actor);
      const release = await service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [draft.id] },
        actor,
      );

      const planned = service.list("release", { status: "planned" });

      expect(planned).toEqual([release]);
    });
  });

  test.each(invalidStatuses)("$name отклоняется при чтении списка", async ({ kind, status }) => {
    await fixture(async (db, service) => {
      const plan = await service.create("work-plan", { title: "Сохранённый план" }, actor);
      const current =
        kind === "work-plan"
          ? plan
          : await service.create(
              "release",
              { title: "Выпуск", version: "1", planIds: [plan.id] },
              actor,
            );
      const generation = db.getGeneration();

      await fails(async () => service.list(kind, { status }), "INVALID_ARGUMENT");

      expect(service.get(kind, current.id)).toEqual(current);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("список этапов возвращает их порядок и ревизию плана", async () => {
    await fixture(async (_db, service) => {
      const plan = await planWithStage(service);

      const composition = service.listStages(plan.key);

      expect(composition).toEqual({
        plan: plan.key,
        revision: plan.revision,
        items: plan.data.stages,
      });
    });
  });

  test("чтение этапа возвращает содержание и ревизию плана", async () => {
    await fixture(async (_db, service) => {
      const plan = await planWithStage(service);
      const stage = stageAt(plan);

      const composition = service.getStage(plan.id, stage.id);

      expect(composition).toEqual({ plan: plan.key, revision: plan.revision, stage });
    });
  });

  test("состав этапа возвращает задачи и ревизию плана-владельца", async () => {
    await fixture(async (_db, service, tasks) => {
      const task = await tasks.create({ title: "Работа" }, actor);
      const plan = await include(service, await planWithStage(service), task);

      const composition = service.stageTasks(plan.key, stageAt(plan).id);

      expect(composition).toEqual({ plan: plan.key, revision: plan.revision, items: [task] });
    });
  });

  test("memberships включает исторический и текущий планы с их собственными ревизиями", async () => {
    await fixture(async (_db, service, tasks) => {
      const task = await tasks.create({ title: "Работа" }, actor);
      const first = await include(service, await planWithStage(service, "Первый"), task);
      const history = await service.transition(
        "work-plan",
        first.id,
        "cancel",
        { result: "Пересмотр" },
        write(first),
      );
      const current = await include(service, await planWithStage(service, "Текущий"), task);

      const memberships = service.memberships(task.key);

      expect(memberships).toEqual({
        task: task.key,
        items: [history, current].map((plan) => ({
          plan: plan.key,
          revision: plan.revision,
          stage: stageAt(plan),
        })),
      });
    });
  });

  test("состав релиза возвращает планы и ревизию релиза-владельца", async () => {
    await fixture(async (_db, service) => {
      const current = await service.create("work-plan", { title: "Текущий" }, actor);
      const release = await service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [current.key] },
        actor,
      );

      const composition = service.releasePlans(release.key);

      expect(composition).toEqual({
        release: release.key,
        revision: release.revision,
        items: [current],
      });
    });
  });

  test("несуществующий этап отклоняется как NOT_FOUND", async () => {
    await fixture(async (_db, service) => {
      const plan = await planWithStage(service);

      await fails(async () => service.getStage(plan.id, "missing"), "NOT_FOUND");
    });
  });

  test("состав этапа и задачи читаются из одного снимка при конкурентной записи после чтения плана", async () => {
    await fixture(async (db, service, tasks) => {
      const task = await tasks.create({ title: "Работа", description: "До записи" }, actor);
      const plan = await include(service, await planWithStage(service), task);
      const writer = ProjectDatabase.open(db.path);
      const originalGet = db.get.bind(db);
      let changed = false;
      const get = spyOn(db, "get").mockImplementation((ref, kind) => {
        const record = originalGet(ref, kind);
        if (record?.id === plan.id && !changed) {
          changed = true;
          writer.transaction(() => {
            // Синхронный читатель удерживает snapshot; конкурентную запись моделируем
            // готовыми строками Storage, а не async сервисом внутри sync callback.
            writer.update(
              {
                ...plan,
                revision: plan.revision + 1,
                data: { ...plan.data, summary: "После записи" },
              },
              plan.revision,
            );
            writer.update(
              {
                ...task,
                revision: task.revision + 1,
                data: { ...task.data, description: "После записи" },
              },
              task.revision,
            );
          });
        }
        return record;
      });
      try {
        const composition = service.stageTasks(plan.id, stageAt(plan).id);

        expect(composition).toEqual({
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
});

describe("Повреждение сохранённых составов планирования", () => {
  test.each(corruptedPlanCases)(
    "$damageName: $operationName отклоняется без записи",
    async ({ damage, run }) => {
      await fixture(async (db, service, tasks) => {
        const task = await tasks.create({ title: "Работа" }, actor);
        const plan = await include(service, await planWithStage(service), task);
        // Намеренно повреждаем сохранённую форму через Storage, обходя предметный API.
        const corrupted = {
          ...plan,
          revision: plan.revision + 1,
          data: { ...plan.data, stages: damage(stageAt(plan)) },
        };
        db.update(corrupted, plan.revision);
        const generation = db.getGeneration();

        await fails(async () => run(service, plan, corrupted, task), "CORRUPT_DATA");

        expect(db.get(plan.id)).toEqual(corrupted);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test.each(corruptedReleaseOperations)(
    "повреждённый состав релиза: $name отклоняется без записи",
    async ({ run }) => {
      await fixture(async (db, service) => {
        const plan = await planWithStage(service);
        const release = await service.create(
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

        await fails(async () => run(service, corrupted), "CORRUPT_DATA");

        expect(db.get(release.id)).toEqual(corrupted);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );
});

describe("Готовность составов планирования", () => {
  test("progress плана с несколькими задачами читает один граф без текстов и журналов задач", async () => {
    await fixture(async (db, service, tasks) => {
      const plan = await planWithCompletedTasks(service, tasks, "Первый", 2);

      const progress = await expectSingleGraphRead(db, async () =>
        service.progress("work-plan", plan.id),
      );

      expect(progress).toMatchObject({
        completed: true,
        counts: { total: 2, completed: 2 },
        blockers: [],
      });
    });
  });

  test.each(completedPlanSizes)(
    "complete плана с $name читает один граф без текстов и журналов задач",
    async ({ count }) => {
      await fixture(async (db, service, tasks) => {
        const plan = await planWithCompletedTasks(service, tasks, "План", count);

        const completed = await expectSingleGraphRead(
          db,
          async () =>
            await service.transition(
              "work-plan",
              plan.id,
              "complete",
              { result: "Готово" },
              write(plan),
            ),
        );

        expect(completed.data.status).toBe("completed");
        expect(completed.revision).toBe(plan.revision + 1);
      });
    },
  );

  test("progress релиза с несколькими планами читает один общий граф без текстов и журналов задач", async () => {
    await fixture(async (db, service, tasks) => {
      const { first, second, release } = await releaseWithCompletedPlans(service, tasks);

      const progress = await expectSingleGraphRead(db, async () =>
        service.progress("release", release.id),
      );

      expect(progress).toMatchObject({
        completed: true,
        counts: { total: 2, completed: 2 },
        plans: [
          { id: first.id, completed: true },
          { id: second.id, completed: true },
        ],
        blockers: [],
      });
    });
  });

  test("publish релиза с несколькими планами читает один общий граф без текстов и журналов задач", async () => {
    await fixture(async (db, service, tasks) => {
      const { release } = await releaseWithCompletedPlans(service, tasks);

      const published = await expectSingleGraphRead(
        db,
        async () => await service.transition("release", release.id, "publish", {}, write(release)),
      );

      expect(published.data.status).toBe("released");
    });
  });
});

describe("Сохранение содержания и порядка этапов", () => {
  test("полные тексты, ссылки ID и порядок этапов сохраняются после повторного открытия", async () => {
    await fixture(async (db, service, tasks) => {
      const task = await tasks.create(
        { title: "Существующая задача", description: markdown },
        actor,
      );
      let plan = await service.create(
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
        { kind: "product", id: new EntityService(db).get("PRODUCT", "product").id },
      ]);
      plan = await service.stage(
        plan.key,
        "create",
        { title: "Первый", outcome: markdown },
        write(plan),
      );
      const first = stageAt(plan).id;
      plan = await service.stage(
        plan.id,
        "create",
        { title: "Второй", before: first },
        write(plan),
      );
      const second = stageAt(plan).id;

      expect(plan.data.stages.map((stage) => stage.id)).toEqual([second, first]);

      plan = await service.stage(
        plan.id,
        "move",
        { stageId: second, direction: "down" },
        write(plan),
      );

      expect(plan.data.stages.map((stage) => stage.id)).toEqual([first, second]);

      plan = await service.stage(plan.id, "move", { stageId: first, before: null }, write(plan));

      expect(plan.data.stages.map((stage) => stage.id)).toEqual([second, first]);

      plan = await service.stage(
        plan.id,
        "update",
        { stageId: first, completionConditions: markdown },
        write(plan),
      );
      plan = await service.stageTask(plan.id, first, task.key, false, write(plan));
      plan = await service.stage(plan.id, "remove", { stageId: second }, write(plan));
      plan = await service.update("work-plan", plan.key, { summary: "Уточнено" }, write(plan));
      const renamedTask = new EntityService(db).rename(
        task.id,
        "task",
        "RENAMED-TASK",
        write(task),
      );

      expect(stageAt(plan).taskIds).toEqual([task.id]);
      expect(tasks.get(task.key).id).toBe(renamedTask.id);
      expect(tasks.get(task.id).data).toEqual(task.data);

      const reopened = ProjectDatabase.open(db.path);
      try {
        const fresh = new PlanningService(reopened);
        expect(fresh.get("work-plan", plan.key)).toEqual(plan);
        expect(fresh.list("work-plan")).toEqual([plan]);
        for (const field of ["goal", "rationale", "boundaries", "expectedResult"] as const) {
          expect(plan.data[field]).toBe(markdown);
        }
        expect(stageAt(plan).outcome).toBe(markdown);
        expect(stageAt(plan).completionConditions).toBe(markdown);
        expect(fresh.progress("work-plan", plan.id).completed).toBe(false);
      } finally {
        reopened.close();
      }
    });
  });
});

describe("Включения задач и ревизии планов", () => {
  test("удаление непустого этапа отклоняется без изменения плана и задачи", async () => {
    await fixture(async (db, service, tasks) => {
      const task = await tasks.create({ title: "Работа" }, actor);
      const plan = await include(service, await planWithStage(service), task);
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.stage(plan.id, "remove", { stageId: stageAt(plan).id }, write(plan)),
        "STAGE_NOT_EMPTY",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(tasks.get(task.id)).toEqual(task);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(membershipTargets)(
    "включение в $name отклоняется при существующем открытом включении",
    async ({ target }) => {
      await fixture(async (db, service, tasks) => {
        const task = await tasks.create({ title: "Общая работа" }, actor);
        let first = await include(service, await planWithStage(service, "Первый"), task);
        first = await service.stage(first.id, "create", { title: "Другой этап" }, write(first));
        const second = await planWithStage(service, "Второй");
        const before = db.getGeneration();

        if (target === "plan") {
          await fails(async () => await include(service, second, task), "MEMBERSHIP_CONFLICT");
        } else {
          await fails(
            async () =>
              await service.stageTask(first.id, stageAt(first, 1).id, task.id, false, write(first)),
            "MEMBERSHIP_CONFLICT",
          );
        }

        expect(db.getGeneration()).toBe(before);
        expect(service.get("work-plan", first.id)).toEqual(first);
        expect(service.get("work-plan", second.id)).toEqual(second);
        expect(tasks.get(task.id)).toEqual(task);
      });
    },
  );

  test("отмена освобождает текущее включение, сохраняя исторический состав и задачу", async () => {
    await fixture(async (_db, service, tasks) => {
      const task = await tasks.create({ title: "Общая работа" }, actor);
      let first = await include(service, await planWithStage(service, "Первый"), task);
      let second = await planWithStage(service, "Второй");

      first = await service.transition(
        "work-plan",
        first.id,
        "cancel",
        { result: markdown },
        write(first),
      );
      second = await include(service, second, task);

      expect(stageAt(first).taskIds).toEqual([task.id]);
      expect(stageAt(second).taskIds).toEqual([task.id]);
      expect(first.data.result).toBe(markdown);
      expect(tasks.get(task.id)).toEqual(task);
    });
  });

  test.each(closedPlanOperations)(
    "$name отменённого плана отклоняется без изменения истории",
    async ({ run }) => {
      await fixture(async (db, service, tasks) => {
        const task = await tasks.create({ title: "Историческая работа" }, actor);
        const initial = await include(service, await planWithStage(service), task);
        const plan = await service.transition(
          "work-plan",
          initial.id,
          "cancel",
          { result: markdown },
          write(initial),
        );
        const generation = db.getGeneration();

        await fails(async () => run(service, plan, task), "PLAN_READ_ONLY");

        expect(service.get("work-plan", plan.id)).toEqual(plan);
        expect(tasks.get(task.id)).toEqual(task);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test.each(stalePlanOperations)(
    "$name с устаревшей ревизией отклоняется после записи другого соединения",
    async ({ run }) => {
      await fixture(async (db, service, tasks) => {
        const task = await tasks.create({ title: "Задача" }, actor);
        const initial = await include(service, await planWithStage(service), task);
        const connection = ProjectDatabase.open(db.path);
        try {
          const concurrent = new PlanningService(connection);
          const current = await concurrent.update(
            "work-plan",
            initial.id,
            { summary: "Другой автор" },
            write(initial),
          );
          const generation = db.getGeneration();

          await fails(async () => run(service, initial, task), "REVISION_CONFLICT");

          expect(
            await service.stageTask(
              current.id,
              stageAt(current).id,
              task.id,
              false,
              write(current),
            ),
          ).toEqual(current);
          expect(db.getGeneration()).toBe(generation);
          expect(service.get("work-plan", current.id)).toEqual(current);
        } finally {
          connection.close();
        }
      });
    },
  );

  test.each(staleTransferOwners)(
    "перенос с устаревшей ревизией $name сохраняет оба плана",
    async ({ owner }) => {
      await fixture(async (db, service, tasks) => {
        const task = await tasks.create({ title: "Переносимая работа" }, actor);
        const source = await include(service, await planWithStage(service, "Источник"), task);
        let target = await planWithStage(service, "Получатель");
        const staleTarget = target;
        target = await service.update(
          "work-plan",
          target.id,
          { summary: "Новая ревизия" },
          write(target),
        );
        const input = {
          task: task.key,
          targetPlan: target.key,
          targetStage: stageAt(target).id,
          reason: "Пересмотр объёма",
        };
        const generation = db.getGeneration();

        await fails(
          async () =>
            await service.transfer(source.id, input, {
              ...write(source),
              ifRevision: owner === "source" ? source.revision - 1 : source.revision,
              targetRevision: owner === "target" ? staleTarget.revision : target.revision,
            }),
          "REVISION_CONFLICT",
        );

        expect(service.get("work-plan", source.id)).toEqual(source);
        expect(service.get("work-plan", target.id)).toEqual(target);
        expect(db.getGeneration()).toBe(generation);
        expect(tasks.get(task.id)).toEqual(task);
      });
    },
  );

  test("отказ второй SQL-записи переноса откатывает оба плана, после снятия отказа перенос сохраняется", async () => {
    await fixture(async (db, service, tasks) => {
      const task = await tasks.create({ title: "Переносимая работа" }, actor);
      const source = await include(service, await planWithStage(service, "Источник"), task);
      const target = await planWithStage(service, "Получатель");
      const input = {
        task: task.key,
        targetPlan: target.key,
        targetStage: stageAt(target).id,
        reason: "Пересмотр объёма",
      };
      const generation = db.getGeneration();

      const sql = new Database(db.path, { create: false, readwrite: true });
      try {
        // Триггер моделирует реальный отказ хранения после успешной первой UPDATE.
        sql.exec(`CREATE TRIGGER reject_transfer BEFORE UPDATE ON entities
          WHEN OLD.id = '${target.id}' BEGIN SELECT RAISE(ABORT, 'Отказ второй записи'); END`);

        const failure = await fails(
          async () =>
            await service.transfer(source.id, input, {
              ...write(source),
              targetRevision: target.revision,
            }),
          "CONFLICT",
        );

        expect(failure.details).toMatchObject({ reason: "Отказ второй записи" });
        expect(service.get("work-plan", source.id)).toEqual(source);
        expect(service.get("work-plan", target.id)).toEqual(target);
        expect(tasks.get(task.id)).toEqual(task);
        expect(db.getGeneration()).toBe(generation);
        sql.exec("DROP TRIGGER reject_transfer");
      } finally {
        sql.close();
      }

      const saved = await service.transfer(source.id, input, {
        ...write(source),
        targetRevision: target.revision,
      });

      expect(stageAt(saved.source).taskIds).toEqual([]);
      expect(stageAt(saved.target).taskIds).toEqual([task.id]);
      expect(saved.source.revision).toBe(source.revision + 1);
      expect(saved.target.revision).toBe(target.revision + 1);
      expect(service.get("work-plan", source.id)).toEqual(saved.source);
      expect(service.get("work-plan", target.id)).toEqual(saved.target);
      expect(db.getGeneration()).toBe(generation + 2);
      expect(tasks.get(task.id)).toEqual(task);
    });
  });

  test.each(invalidSamePlanTransfers)(
    "$name отклоняет перенос между этапами одного плана без записи",
    async ({ reason, targetRevisionDelta, code }) => {
      await fixture(async (db, service, tasks) => {
        const task = await tasks.create({ title: "Задача" }, actor);
        let plan = await include(service, await planWithStage(service), task);
        plan = await service.stage(plan.id, "create", { title: "Получатель" }, write(plan));
        const input = {
          task: task.id,
          targetPlan: plan.id,
          targetStage: stageAt(plan, 1).id,
          reason,
        };
        const before = db.getGeneration();

        await fails(
          async () =>
            await service.transfer(plan.id, input, {
              ...write(plan),
              targetRevision: plan.revision + targetRevisionDelta,
            }),
          code,
        );

        expect(service.get("work-plan", plan.id)).toEqual(plan);
        expect(tasks.get(task.id)).toEqual(task);
        expect(db.getGeneration()).toBe(before);
      });
    },
  );

  test("перенос между этапами одного плана сохраняет одну ревизию, а повтор остаётся no-op", async () => {
    await fixture(async (db, service, tasks) => {
      const task = await tasks.create({ title: "Задача" }, actor);
      let plan = await include(service, await planWithStage(service), task);
      plan = await service.stage(plan.id, "create", { title: "Получатель" }, write(plan));
      const input = {
        task: task.id,
        targetPlan: plan.id,
        targetStage: stageAt(plan, 1).id,
        reason: "Уточнён порядок",
      };
      const options = { ...write(plan), targetRevision: plan.revision };

      const saved = await service.transfer(plan.id, input, options);

      expect(saved.source).toEqual(saved.target);
      expect(saved.target.revision).toBe(plan.revision + 1);
      expect(saved.target.data.stages.map((stage) => stage.taskIds)).toEqual([[], [task.id]]);
      expect(tasks.get(task.id)).toEqual(task);
      const generation = db.getGeneration();

      const repeated = await service.transfer(plan.id, input, {
        ...write(saved.target),
        targetRevision: saved.target.revision,
      });

      expect(repeated.target).toEqual(saved.target);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Переходы состояния планов", () => {
  test("начало плана с целью и пустым этапом отклоняется без записи", async () => {
    await fixture(async (db, service) => {
      const plan = await planWithStage(service);
      const generation = db.getGeneration();

      await fails(
        async () => await service.transition("work-plan", plan.id, "start", {}, write(plan)),
        "NOT_READY",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("пустой план нельзя завершить и его прогресс остаётся нулевым", async () => {
    await fixture(async (db, service) => {
      const plan = await service.create("work-plan", { title: "Черновик" }, actor);
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.transition(
            "work-plan",
            plan.id,
            "complete",
            { result: markdown },
            write(plan),
          ),
        "NOT_READY",
      );

      expect(service.progress("work-plan", plan.id)).toMatchObject({
        completed: false,
        counts: { total: 0, completed: 0, percent: 0 },
      });
      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("состав без цели не допускает начало плана, добавление цели разрешает переход", async () => {
    await fixture(async (db, service, tasks) => {
      let plan = await service.create("work-plan", { title: "Черновик" }, actor);
      plan = await service.stage(plan.id, "create", { title: "Этап" }, write(plan));
      const task = await tasks.create({ title: "Работа" }, actor);
      plan = await include(service, plan, task);
      const generation = db.getGeneration();

      await fails(
        async () => await service.transition("work-plan", plan.id, "start", {}, write(plan)),
        "NOT_READY",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(generation);

      plan = await service.update("work-plan", plan.id, { goal: markdown }, write(plan));
      plan = await service.transition("work-plan", plan.id, "start", {}, write(plan));

      expect(plan.data.status).toBe("active");
      expect(plan.data.startedAt).toBeString();
      expect(tasks.get(task.id)).toEqual(task);
    });
  });

  test("пробельный результат отмены отклоняется без изменения активного плана", async () => {
    await fixture(async (db, service, tasks) => {
      const task = await tasks.create({ title: "Работа" }, actor);
      const initial = await include(service, await planWithStage(service), task);
      const plan = await service.transition("work-plan", initial.id, "start", {}, write(initial));
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.transition("work-plan", plan.id, "cancel", { result: "\n " }, write(plan)),
        "VALIDATION_ERROR",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(tasks.get(task.id)).toEqual(task);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("готовность задачи к закрытию и выполненные критерии ещё не означают выполнение плана", async () => {
    await fixture(async (db, service, tasks) => {
      let task = await tasks.create(
        {
          title: "Работа с критерием",
          acceptanceCriteria: [{ title: "Проверено внешним инструментом" }],
        },
        actor,
      );
      const plan = await include(service, await planWithStage(service), task);
      const initialGeneration = db.getGeneration();

      await fails(
        async () =>
          await service.transition(
            "work-plan",
            plan.id,
            "complete",
            { result: markdown },
            write(plan),
          ),
        "NOT_READY",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(initialGeneration);
      const criterion = task.data.acceptanceCriteria[0];
      if (!criterion) {
        throw new Error("В подготовленной задаче отсутствует критерий");
      }
      task = await tasks.criterion(task.id, "complete", { id: criterion.id }, write(task));
      task = await tasks.move(task.id, { column: "review" }, write(task));

      expect(tasks.progress(task.id)).toMatchObject({ completed: false, canComplete: true });
      expect(service.progress("work-plan", plan.id).completed).toBe(false);
      const readyGeneration = db.getGeneration();

      await fails(
        async () =>
          await service.transition(
            "work-plan",
            plan.id,
            "complete",
            { result: markdown },
            write(plan),
          ),
        "NOT_READY",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(readyGeneration);

      await tasks.move(task.id, { column: "done" }, write(task));

      expect(service.progress("work-plan", plan.id).completed).toBe(true);
    });
  });

  test("done без актуальных зависимостей и детей не завершает план; пустой этап не блокирует", async () => {
    await fixture(async (db, service, tasks) => {
      let dependency = await tasks.create({ title: "Внешняя зависимость", column: "done" }, actor);
      let parent = await tasks.create(
        { title: "Собственная задача", dependencies: [dependency.id] },
        actor,
      );
      let child = await tasks.create(
        { title: "Дочерняя работа", parent: parent.id, column: "done" },
        actor,
      );
      parent = await tasks.move(parent.id, { column: "done" }, write(parent));
      let plan = await include(service, await planWithStage(service), parent);
      plan = await service.stage(plan.id, "create", { title: "Пустой этап" }, write(plan));
      dependency = await tasks.move(dependency.id, { column: "ready" }, write(dependency));
      const before = db.getGeneration();
      expect(service.progress("work-plan", plan.id)).toMatchObject({
        completed: false,
        counts: { total: 1, completed: 0 },
      });
      expect(service.progress("work-plan", plan.id).blockers).toContain(dependency.id);

      await fails(
        async () =>
          await service.transition(
            "work-plan",
            plan.id,
            "complete",
            { result: markdown },
            write(plan),
          ),
        "NOT_READY",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(before);

      dependency = await tasks.move(dependency.id, { column: "done" }, write(dependency));
      child = await tasks.move(child.id, { column: "in-progress" }, write(child));
      const reopenedGeneration = db.getGeneration();

      await fails(
        async () =>
          await service.transition(
            "work-plan",
            plan.id,
            "complete",
            { result: markdown },
            write(plan),
          ),
        "NOT_READY",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(reopenedGeneration);

      child = await tasks.move(child.id, { column: "done" }, write(child));
      const ready = service.progress("work-plan", plan.id);

      expect(ready).toMatchObject({
        completed: true,
        counts: { total: 1, completed: 1, percent: 100 },
      });
      expect(ready.stages).toMatchObject([{ completed: true }, { completed: false }]);
      expect(plan.data.status).toBe("draft");

      plan = await service.transition(
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
      const completedGeneration = db.getGeneration();

      await fails(
        async () => await service.update("work-plan", plan.id, { summary: "Нельзя" }, write(plan)),
        "PLAN_READ_ONLY",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(completedGeneration);

      const next = await include(service, await planWithStage(service, "Следующий план"), parent);

      expect(stageAt(next).taskIds).toEqual([parent.id]);
      expect(stageAt(service.get("work-plan", plan.id)).taskIds).toEqual([parent.id]);
    });
  });
});

describe("Публикация и перепланирование релизов", () => {
  test("релиз требует завершённых планов с актуально выполненными задачами и сохраняет факт выпуска после reopen", async () => {
    await fixture(async (db, service, tasks) => {
      let task = await tasks.create({ title: "Первая работа", column: "done" }, actor);
      const otherTask = await tasks.create({ title: "Вторая работа", column: "done" }, actor);
      let first = await include(service, await planWithStage(service, "Первый"), task);
      let second = await include(service, await planWithStage(service, "Второй"), otherTask);
      first = await service.transition(
        "work-plan",
        first.id,
        "complete",
        { result: markdown },
        write(first),
      );
      let release = await service.create(
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
      const beforeIncompletePlan = db.getGeneration();

      await fails(
        async () => await service.transition("release", release.id, "publish", {}, write(release)),
        "NOT_READY",
      );

      expect(service.get("release", release.id)).toEqual(release);
      expect(service.get("work-plan", second.id)).toEqual(second);
      expect(db.getGeneration()).toBe(beforeIncompletePlan);
      expect(service.progress("release", release.id)).toMatchObject({
        completed: false,
        counts: { total: 2, completed: 1 },
      });
      second = await service.transition(
        "work-plan",
        second.id,
        "complete",
        { result: "Выполнено" },
        write(second),
      );

      expect(service.progress("release", release.id).completed).toBe(true);
      expect(service.get("release", release.id).data.status).toBe("planned");
      task = await tasks.move(task.id, { column: "in-progress" }, write(task));
      const generation = db.getGeneration();

      await fails(
        async () => await service.transition("release", release.id, "publish", {}, write(release)),
        "NOT_READY",
      );

      expect(service.get("release", release.id)).toEqual(release);
      expect(service.get("work-plan", first.id)).toEqual(first);
      expect(service.progress("work-plan", first.id).completed).toBe(false);
      expect(db.getGeneration()).toBe(generation);

      task = await tasks.move(task.id, { column: "done" }, write(task));
      release = await service.transition(
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

      await tasks.move(task.id, { column: "ready" }, write(task));
      const afterReopen = db.getGeneration();

      expect(service.progress("release", release.id).completed).toBe(false);
      expect(service.get("release", release.id)).toEqual(release);
      expect(db.getGeneration()).toBe(afterReopen);
      expect(service.list("release")).toEqual([release]);
    });
  });

  test.each(releaseReadOnlyActions)(
    "$name выпущенного релиза отклоняется без записи",
    async ({ action }) => {
      await fixture(async (db, service, tasks) => {
        const release = await publishedRelease(service, tasks);
        const generation = db.getGeneration();

        await fails(
          async () => await service.transition("release", release.id, action, {}, write(release)),
          "RELEASE_READ_ONLY",
        );

        expect(service.get("release", release.id)).toEqual(release);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("изменение версии выпущенного релиза отклоняется без записи", async () => {
    await fixture(async (db, service, tasks) => {
      const release = await publishedRelease(service, tasks);
      const generation = db.getGeneration();

      await fails(
        async () => await service.update("release", release.id, { version: "2.0" }, write(release)),
        "RELEASE_READ_ONLY",
      );

      expect(service.get("release", release.id)).toEqual(release);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("одинаковая версия разрешена у независимых релизов", async () => {
    await fixture(async (_db, service) => {
      const plan = await service.create("work-plan", { title: "План" }, actor);
      const first = await service.create(
        "release",
        { title: "Первый выпуск", version: "1.0", planIds: [plan.id] },
        actor,
      );

      const second = await service.create(
        "release",
        { title: "Второй выпуск", version: "1.0", planIds: [plan.key] },
        actor,
      );

      expect(second.id).not.toBe(first.id);
      expect(second.data.version).toBe(first.data.version);
      expect(service.list("release")).toEqual([first, second]);
    });
  });

  test("отменённый релиз перепланируется явно, а устаревший повтор отклоняется до no-op", async () => {
    await fixture(async (db, service) => {
      const plan = await planWithStage(service);
      let release = await service.create(
        "release",
        { title: "Выпуск", version: "1.0", planIds: [plan.id] },
        actor,
      );
      release = await service.transition("release", release.id, "cancel", {}, write(release));
      release = await service.update(
        "release",
        release.id,
        { description: markdown },
        write(release),
      );

      expect(release.data.status).toBe("cancelled");
      expect(service.get("work-plan", plan.id)).toEqual(plan);
      const beforeInvalidTransition = db.getGeneration();

      await fails(
        async () => await service.transition("release", release.id, "publish", {}, write(release)),
        "INVALID_TRANSITION",
      );

      expect(service.get("release", release.id)).toEqual(release);
      expect(db.getGeneration()).toBe(beforeInvalidTransition);
      const cancelled = release;
      release = await service.transition("release", release.id, "plan", {}, write(release));

      expect(release.data.status).toBe("planned");
      const beforeStaleRetry = db.getGeneration();

      await fails(
        async () => await service.transition("release", release.id, "plan", {}, write(cancelled)),
        "REVISION_CONFLICT",
      );

      expect(service.get("release", release.id)).toEqual(release);
      expect(db.getGeneration()).toBe(beforeStaleRetry);

      const unchanged = await service.transition("release", release.id, "plan", {}, write(release));

      expect(unchanged).toEqual(release);
      expect(db.getGeneration()).toBe(beforeStaleRetry);
    });
  });

  test("изменение состава релиза сохраняет прежний отменённый план и разрешает новый открытый", async () => {
    await fixture(async (db, service) => {
      const initialPlan = await service.create("work-plan", { title: "Прежний план" }, actor);
      const release = await service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [initialPlan.id] },
        actor,
      );
      const cancelled = await service.transition(
        "work-plan",
        initialPlan.id,
        "cancel",
        { result: "Состав работы пересмотрен" },
        write(initialPlan),
      );
      const current = await service.create("work-plan", { title: "Новый план" }, actor);
      const generation = db.getGeneration();

      const updated = await service.update(
        "release",
        release.id,
        { planIds: [current.key, cancelled.key] },
        write(release),
      );

      expect(updated.data).toEqual({ ...release.data, planIds: [current.id, cancelled.id] });
      expect(updated.revision).toBe(release.revision + 1);
      expect(service.get("release", release.id)).toEqual(updated);
      expect(service.get("work-plan", cancelled.id)).toEqual(cancelled);
      expect(service.get("work-plan", current.id)).toEqual(current);
      expect(db.getGeneration()).toBe(generation + 1);
    });
  });

  test("новое включение отменённого плана в релиз отклоняется без изменения прежнего состава", async () => {
    await fixture(async (db, service) => {
      const current = await service.create("work-plan", { title: "Текущий план" }, actor);
      const release = await service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [current.id] },
        actor,
      );
      const initialPlan = await service.create("work-plan", { title: "Не включённый план" }, actor);
      const cancelled = await service.transition(
        "work-plan",
        initialPlan.id,
        "cancel",
        { result: "Работа отменена" },
        write(initialPlan),
      );
      const generation = db.getGeneration();

      const failure = await fails(
        async () =>
          await service.update(
            "release",
            release.id,
            { planIds: [current.key, cancelled.key] },
            write(release),
          ),
        "INVALID_PLAN",
      );

      expect(failure.details).toMatchObject({ id: cancelled.id });
      expect(service.get("release", release.id)).toEqual(release);
      expect(service.get("work-plan", current.id)).toEqual(current);
      expect(service.get("work-plan", cancelled.id)).toEqual(cancelled);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("перепланирование релиза с прежним отменённым планом отклоняется без изменения записей", async () => {
    await fixture(async (db, service) => {
      const initialPlan = await service.create("work-plan", { title: "План выпуска" }, actor);
      const initialRelease = await service.create(
        "release",
        { title: "Выпуск", version: "1", planIds: [initialPlan.id] },
        actor,
      );
      const plan = await service.transition(
        "work-plan",
        initialPlan.id,
        "cancel",
        { result: "Работа отменена" },
        write(initialPlan),
      );
      const release = await service.transition(
        "release",
        initialRelease.id,
        "cancel",
        {},
        write(initialRelease),
      );
      const generation = db.getGeneration();

      const failure = await fails(
        async () => await service.transition("release", release.id, "plan", {}, write(release)),
        "INVALID_PLAN",
      );

      expect(failure.details).toMatchObject({ id: plan.id });
      expect(service.get("release", release.id)).toEqual(release);
      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Проверка внешнего ввода планирования", () => {
  test.each(invalidPlanInputs)(
    "$name отклоняется при создании плана без записи",
    async ({ input }) => {
      await fixture(async (db, service) => {
        const generation = db.getGeneration();

        await fails(
          async () => await service.create("work-plan", input, actor),
          "VALIDATION_ERROR",
        );

        expect(service.list("work-plan")).toEqual([]);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("повтор области проекта через ID и ключ отклоняется без записи", async () => {
    await fixture(async (db, service) => {
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.create(
            "work-plan",
            {
              title: "План",
              scope: [
                { kind: "project", id: "PROJECT" },
                { kind: "project", id: db.projectId },
              ],
            },
            actor,
          ),
        "VALIDATION_ERROR",
      );

      expect(service.list("work-plan")).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(invalidReleaseFields)(
    "$name отклоняется при создании релиза без записи",
    async ({ input }) => {
      await fixture(async (db, service) => {
        const plan = await planWithStage(service);
        const before = db.getGeneration();

        await fails(
          async () =>
            await service.create(
              "release",
              {
                title: "Выпуск",
                version: "1",
                planIds: [plan.id],
                ...input,
              },
              actor,
            ),
          "VALIDATION_ERROR",
        );

        expect(service.list("release")).toEqual([]);
        expect(service.get("work-plan", plan.id)).toEqual(plan);
        expect(db.getGeneration()).toBe(before);
      });
    },
  );

  test("повтор плана через ID и ключ отклоняет создание релиза без записи", async () => {
    await fixture(async (db, service) => {
      const plan = await planWithStage(service);
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.create(
            "release",
            {
              title: "Выпуск",
              version: "1",
              planIds: [plan.id, plan.key],
            },
            actor,
          ),
        "VALIDATION_ERROR",
      );

      expect(service.list("release")).toEqual([]);
      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("превышение лимита планов отклоняет создание релиза без записи", async () => {
    await fixture(async (db, service) => {
      // Все ссылки валидны и уникальны: отказ должен вызваться размером состава, а не дублем.
      const plans: WorkPlanRecord[] = [];
      for (let index = 0; index < 201; index++) {
        plans.push(await service.create("work-plan", { title: `План ${index + 1}` }, actor));
      }
      const savedPlans = service.list("work-plan");
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.create(
            "release",
            {
              title: "Выпуск",
              version: "1",
              planIds: plans.map((plan) => plan.id),
            },
            actor,
          ),
        "VALIDATION_ERROR",
      );

      expect(service.list("release")).toEqual([]);
      expect(service.list("work-plan")).toEqual(savedPlans);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("несуществующий план отклоняет создание релиза без записи", async () => {
    await fixture(async (db, service) => {
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.create(
            "release",
            { title: "Выпуск", version: "1", planIds: ["MISSING"] },
            actor,
          ),
        "NOT_FOUND",
      );

      expect(service.list("release")).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("прямая запись taskIds отклоняет изменение этапа без записи", async () => {
    await fixture(async (db, service) => {
      const plan = await planWithStage(service);
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.stage(
            plan.id,
            "update",
            { stageId: stageAt(plan).id, taskIds: [] },
            write(plan),
          ),
        "VALIDATION_ERROR",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("конфликт before и direction отклоняет перенос этапа без записи", async () => {
    await fixture(async (db, service) => {
      const plan = await planWithStage(service);
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.stage(
            plan.id,
            "move",
            { stageId: stageAt(plan).id, before: null, direction: "up" },
            write(plan),
          ),
        "VALIDATION_ERROR",
      );

      expect(service.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("неположительная ревизия отклоняет изменение плана без записи", async () => {
    await fixture(async (db, service) => {
      const plan = await planWithStage(service);
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.update(
            "work-plan",
            plan.id,
            { title: "Изменено" },
            { actor, ifRevision: 0 },
          ),
        "VALIDATION_ERROR",
      );

      expect(db.getGeneration()).toBe(generation);
      expect(service.get("work-plan", plan.id)).toEqual(plan);
    });
  });

  test("отменённый план отклоняет создание релиза без записи", async () => {
    await fixture(async (db, service) => {
      const plan = await planWithStage(service);
      const cancelled = await service.transition(
        "work-plan",
        plan.id,
        "cancel",
        { result: "Не нужно" },
        write(plan),
      );
      const generation = db.getGeneration();

      await fails(
        async () =>
          await service.create(
            "release",
            { title: "Выпуск", version: "1", planIds: [cancelled.id] },
            actor,
          ),
        "INVALID_PLAN",
      );

      expect(service.list("release")).toEqual([]);
      expect(service.get("work-plan", plan.id)).toEqual(cancelled);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(sparseInputCases)(
    "$name, $shape: $actionName отклоняется без изменения данных, ревизий и поколения",
    async ({ field, kind, hasFirst, action }) => {
      await fixture(async (db, service) => {
        const plan = await planWithStage(service);
        const creation =
          kind === "release"
            ? { title: "Выпуск", version: "1", planIds: [plan.id] }
            : { title: "План" };
        const current = kind === "release" ? await service.create(kind, creation, actor) : plan;
        const records = db.list();
        const generation = db.getGeneration();
        // Пустые позиции массива намеренно не заполняются: это внешний неверный ввод.
        const sparse = new Array<unknown>(hasFirst ? 2 : 1);
        if (hasFirst) {
          switch (field) {
            case "planIds":
              sparse[0] = plan.id;
              break;
            case "scope":
              sparse[0] = { kind: "project", id: "PROJECT" };
              break;
            case "participants":
              sparse[0] = actor;
              break;
          }
        }

        if (action === "create") {
          await fails(
            async () => await service.create(kind, { ...creation, [field]: sparse }, actor),
            "VALIDATION_ERROR",
          );
        } else {
          await fails(
            async () =>
              await service.update(
                kind,
                current.id,
                { summary: "Не сохранять", [field]: sparse },
                write(current),
              ),
            "VALIDATION_ERROR",
          );
        }

        expect(db.list()).toEqual(records);
        expect(service.get(kind, current.id)).toEqual(current);
        expect(db.getGeneration()).toBe(generation);
        expect(service.progress(kind, current.id).completed).toBe(false);

        const updated = await service.update(
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
});

describe("Повреждённые ссылки составов планирования", () => {
  test.each(brokenCompositionOperations)(
    "отсутствующая задача: $name отклоняется без изменения записей",
    async ({ run }) => {
      await fixture(async (db, service) => {
        const initial = await planWithStage(service);
        // Намеренная битая ссылка сохраняется низкоуровневым fixture Storage.
        const plan = {
          ...initial,
          revision: initial.revision + 1,
          data: {
            ...initial.data,
            stages: initial.data.stages.map((stage) => ({
              ...stage,
              taskIds: ["missing-task-id"],
            })),
          },
        };
        db.update(plan, initial.revision);
        const release = await service.create(
          "release",
          { title: "Выпуск", version: "1", planIds: [plan.id] },
          actor,
        );
        const before = db.getGeneration();

        await fails(async () => run(service, plan, release), "NOT_FOUND");

        expect(db.getGeneration()).toBe(before);
        expect(service.get("work-plan", plan.id)).toEqual(plan);
        expect(service.get("release", release.id)).toEqual(release);
      });
    },
  );
});
