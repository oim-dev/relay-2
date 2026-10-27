import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { TasksService } from "../../src/tasks/tasks";
import { TaskViewsService } from "../../src/tasks/task-views";
import { CommandExecutor } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import * as taskData from "../../src/tasks/task-data";

let directory: string;
let db: ProjectDatabase;
let tasks: TasksService;
let views: TaskViewsService;

/**
 * Проверяет именно предметный отказ, не принимая случайное исключение за ожидаемый результат.
 */
function expectCode(read: () => unknown, code: string): void {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    if (!(error instanceof RelayError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Ожидался отказ ${code}`);
}

beforeEach(() => {
  const parent = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "task-view-fixtures",
  );
  mkdirSync(parent, { recursive: true });
  directory = mkdtempSync(join(parent, "core-"));
  db = ProjectDatabase.create(join(directory, "project.sqlite"), {
    id: crypto.randomUUID(),
    name: "Проекции задач",
    slug: "task-views",
  });
  tasks = new TasksService(db);
  views = new TaskViewsService(db);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Компактная страница задач Core", () => {
  test("сводка цели считает только выбранные задачи, не пустые требования и не чужие задачи", async () => {
    const feature = await new KnowledgeService(db).create("feature", { name: "Цель" }, "Автор");
    const selected = await tasks.create(
      { board: "product", title: "Задача цели", column: "done", targets: [feature.id] },
      "Автор",
    );
    await tasks.create({ board: "product", title: "Чужая задача", column: "ready" }, "Автор");

    const page = views.page({ productTarget: feature.id });

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: selected.id,
      targets: [{ kind: "feature", id: feature.id }],
      progress: { completed: true },
    });
    expect(page.counts).toMatchObject({
      total: 1,
      completed: 1,
      allCompleted: true,
      targetedTotal: 1,
      targetedCompleted: 1,
    });
    const board = views.page({ board: "product", limit: 1 });
    expect(board.counts).toMatchObject({
      total: 2,
      completed: 1,
      allCompleted: false,
      targetedTotal: 1,
      targetedCompleted: 1,
    });
    const emptyFeature = await new KnowledgeService(db).create(
      "feature",
      { name: "Без задач" },
      "Автор",
    );
    expect(views.page({ productTarget: emptyFeature.id }).counts).toMatchObject({
      total: 0,
      completed: 0,
      allCompleted: false,
    });
  });

  test("ready, сводка и окно используют один граф, не выдавая тексты и журнал", async () => {
    const dependency = await tasks.create(
      { board: "product", title: "Зависимость", column: "ready" },
      "Автор",
    );
    const blocked = await tasks.create(
      { board: "product", title: "Ожидающая", column: "ready", dependencies: [dependency.id] },
      "Автор",
    );
    const ownCriterion = await tasks.create(
      {
        board: "product",
        title: "Собственная приёмка",
        column: "ready",
        description: "СЕКРЕТ_ТЕЛА",
        acceptanceCriteria: [{ title: "СЕКРЕТ_КРИТЕРИЯ" }],
      },
      "Автор",
    );
    await tasks.comment(ownCriterion.id, "СЕКРЕТ_ЖУРНАЛА", "Автор");
    const finished = await tasks.create(
      { board: "product", title: "Выполненная", column: "done" },
      "Автор",
    );
    const graphRead = spyOn(db, "listTaskGraph");
    const decodeNode = spyOn(taskData, "taskGraphNode");
    const fullRead = spyOn(db, "list");
    try {
      const page = views.page({ readiness: "ready", limit: 1 });

      expect(graphRead).toHaveBeenCalledTimes(1);
      expect(decodeNode).toHaveBeenCalledTimes(4);
      expect(fullRead).toHaveBeenCalledTimes(0);
      expect(page.total).toBe(2);
      expect(page.nextOffset).toBe(1);
      expect(page.counts).toEqual({
        total: 2,
        completed: 0,
        allCompleted: false,
        targetedTotal: 0,
        targetedCompleted: 0,
        blocked: 0,
        columns: { inbox: 0, ready: 2, "in-progress": 0, review: 0, done: 0, cancelled: 0 },
      });
      expect(page.items.map((item) => item.id)).toEqual([dependency.id]);
      const second = views.page({
        readiness: "ready",
        offset: 1,
        limit: 1,
        generation: page.generation,
      });
      expect(second.items[0]).toMatchObject({
        id: ownCriterion.id,
        boardSlug: "product",
        acceptance: { total: 1, completed: 0 },
        progress: { completed: false, canComplete: false, blockers: [] },
      });
      expect(second.nextOffset).toBeNull();
      const serialized = JSON.stringify(second);
      expect(serialized).not.toContain("СЕКРЕТ_");
      expect(serialized).not.toContain('"description"');
      expect(serialized).not.toContain('"comments"');
      const blockedPage = views.page({ q: "Ожидающая", readiness: "blocked", searchIn: "title" });
      expect(blockedPage.items[0]).toMatchObject({
        id: blocked.id,
        progress: { completed: false, canComplete: false, blockers: [dependency.id] },
      });
      expect(views.page({ ref: finished.key }).counts.allCompleted).toBe(true);
      const bodySearch = views.page({ q: "СЕКРЕТ_ТЕЛА", searchIn: "all" });
      expect(bodySearch.items.map((item) => item.id)).toEqual([ownCriterion.id]);
      expect(fullRead.mock.calls.filter(([kind]) => kind === "task")).toHaveLength(1);
    } finally {
      graphRead.mockRestore();
      decodeNode.mockRestore();
      fullRead.mockRestore();
    }
  });

  test("устаревшее продолжение отвергается до графа, пустое окно сохраняет total", async () => {
    const task = await tasks.create({ board: "product", title: "Единственная" }, "Автор");
    const first = views.page({ limit: 1 });
    const empty = views.page({ offset: 1, generation: first.generation });
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(1);
    expect(empty.counts.total).toBe(1);
    expect(empty.nextOffset).toBeNull();
    await tasks.comment(task.id, "Новое поколение без смены содержания", "Автор");
    const graphRead = spyOn(db, "listTaskGraph");
    try {
      expectCode(() => views.page({ offset: 1, generation: first.generation }), "PAGE_CHANGED");
      expectCode(() => views.page({ offset: 1 }), "INVALID_ARGUMENT");
      expect(graphRead).toHaveBeenCalledTimes(0);
    } finally {
      graphRead.mockRestore();
    }
  });

  test("повреждённая колонка вне совпадений не превращается в пустую успешную сводку", async () => {
    const task = await tasks.create({ board: "product", title: "Повреждённая" }, "Автор");
    // Намеренная порча сохранённого поля обходит Core и проверяет границу декодирования reader.
    db.update(
      { ...task, revision: task.revision + 1, data: { ...task.data, column: "неизвестная" } },
      task.revision,
    );
    const generation = db.getGeneration();

    expectCode(() => views.page({ q: "Нет совпадений", searchIn: "title" }), "CORRUPT_DATA");

    expect(db.getGeneration()).toBe(generation);
  });

  test("кандидаты исключают чужое включение до окна и допускают свой этап", async () => {
    const assigned = await tasks.create({ board: "product", title: "Включённая" }, "Автор");
    const free = await tasks.create(
      { board: "product", title: "Свободная", column: "cancelled" },
      "Автор",
    );
    const receipt = await new CommandExecutor(db).executeCommands(
      [
        { op: "plan.create", as: "plan", input: { title: "План" } },
        {
          op: "plan.stage.create",
          ref: { $ref: "plan" },
          as: "stage",
          ifRevision: { $revision: "plan" },
          input: { title: "Этап" },
        },
        {
          op: "plan.stage.task.add",
          ref: { $ref: "plan" },
          ifRevision: { $revision: "stage" },
          input: { stageId: { $ref: "stage" }, task: assigned.id },
        },
      ],
      { actor: "Автор" },
    );
    const plan = receipt.items[0]!.id;
    const stageId = receipt.items[1]!.id;
    const list = spyOn(db, "list");
    const graphRead = spyOn(db, "listTaskGraph");
    try {
      const page = views.candidates({ availableOnly: true, limit: 1 });

      expect(page.total).toBe(1);
      expect(page.items.map((item) => item.id)).toEqual([free.id]);
      expect(page.items[0]?.assignment).toBeNull();
      expect(graphRead).toHaveBeenCalledTimes(1);
      expect(list.mock.calls.filter(([kind]) => kind === "work-plan")).toHaveLength(1);
      const own = views.candidates({ plan, stageId, availableOnly: true, limit: 1 });
      expect(own.total).toBe(2);
      expect(own.items[0]?.assignment).toMatchObject({ planId: plan, stageId });
    } finally {
      list.mockRestore();
      graphRead.mockRestore();
    }
  });

  test("внешний WAL commit не смешивает поколение, карточку и готовность текущего чтения", async () => {
    const original = await tasks.create(
      { board: "product", title: "До записи", column: "ready" },
      "Автор",
    );
    const generation = db.getGeneration();
    const writer = ProjectDatabase.open(join(directory, "project.sqlite"));
    const readGraph = db.listTaskGraph.bind(db);
    const barrier = spyOn(db, "listTaskGraph").mockImplementation(() => {
      // Генерация уже прочитана и удерживает reader snapshot; writer коммитит независимо.
      writer.update(
        {
          ...original,
          revision: original.revision + 1,
          data: { ...original.data, title: "После записи", column: "done" },
        },
        original.revision,
      );
      return readGraph();
    });
    try {
      const page = views.page({ ref: original.id });

      expect(page.generation).toBe(generation);
      expect(page.items[0]).toMatchObject({
        title: "До записи",
        revision: original.revision,
        progress: { completed: false },
      });
      expect(page.counts.completed).toBe(0);
    } finally {
      barrier.mockRestore();
      writer.close();
    }
    const current = views.page({ ref: original.id });
    expect(current.generation).toBeGreaterThan(generation);
    expect(current.items[0]).toMatchObject({
      title: "После записи",
      progress: { completed: true },
    });
  });
});
