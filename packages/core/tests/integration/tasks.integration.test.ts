import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  RelayError,
  TASK_COLUMNS,
  type EntityRecord,
  type TaskCriterion,
  type TaskRecord,
  type WriteOptions,
} from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { CommandExecutor } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import type { ApplicationBoardFixture } from "./helpers/task-fixture.types";

const invalidTaskInputs = [
  { name: "null вместо заголовка", input: { title: null } },
  { name: "многострочный заголовок", input: { title: "Две\nстроки" } },
  { name: "явный undefined в заголовке", input: { title: undefined } },
  { name: "неизвестная колонка", input: { column: "blocked" } },
  { name: "строка вместо массива зависимостей", input: { dependencies: "PRODUCT-1" } },
  { name: "неизвестное поле progress", input: { progress: 100 } },
  { name: "пустой заголовок критерия", input: { acceptanceCriteria: [{ title: "" }] } },
  {
    name: "превышение лимита критериев",
    input: { acceptanceCriteria: Array.from({ length: 101 }, () => ({ title: "Критерий" })) },
  },
] as const;

const invalidTaskFilters = [
  { name: "неизвестная готовность", input: { readiness: "almost" } },
  { name: "поиск по комментариям", input: { searchIn: "comments" } },
  { name: "неизвестное поле", input: { unexpected: true } },
] as const;

const taskPageCases = [
  {
    name: "общая страница по ключу",
    filter: "all",
    offset: 0,
    sort: "key",
    item: "parent",
    total: 4,
  },
  {
    name: "страница детей по ключу родителя и заголовку",
    filter: "key",
    offset: 1,
    sort: "title",
    item: "last",
    total: 2,
  },
  {
    name: "пустая страница детей по ID родителя",
    filter: "id",
    offset: 2,
    sort: "key",
    item: "empty",
    total: 2,
  },
] as const;

const corruptedDependencyOperations = [
  {
    name: "чтение карточки",
    /**
     * Читает полное содержание повреждённой задачи.
     */
    run: (record: EntityRecord): unknown => tasks.get(record.id),
  },
  {
    name: "чтение зависимостей",
    /**
     * Читает состав обязательств повреждённой задачи.
     */
    run: (record: EntityRecord): unknown => tasks.dependencies(record.id),
  },
  {
    name: "изменение заголовка",
    /**
     * Пытается изменить содержание по исходной ревизии повреждённой записи.
     */
    run: (record: EntityRecord): unknown =>
      tasks.update(record.id, { title: "Не сохранять" }, options(record)),
  },
  {
    name: "перенос колонки",
    /**
     * Пытается перенести повреждённую задачу в ready.
     */
    run: (record: EntityRecord): unknown =>
      tasks.move(record.id, { column: "ready" }, options(record)),
  },
  {
    name: "установка родителя",
    /**
     * Пытается назначить существующего родителя повреждённой задаче.
     */
    run: (record: EntityRecord, target: TaskRecord): unknown =>
      tasks.setParent(record.id, target.id, options(record)),
  },
  {
    name: "добавление зависимости",
    /**
     * Пытается добавить существующее обязательство к повреждённой задаче.
     */
    run: (record: EntityRecord, target: TaskRecord): unknown =>
      tasks.dependency(record.id, target.id, false, options(record)),
  },
  {
    name: "добавление связи",
    /**
     * Пытается добавить информационную связь повреждённой задачи.
     */
    run: (record: EntityRecord, target: TaskRecord): unknown =>
      tasks.related(record.id, target.id, false, options(record)),
  },
  {
    name: "добавление критерия",
    /**
     * Пытается добавить критерий повреждённой задачи.
     */
    run: (record: EntityRecord): unknown =>
      tasks.criterion(record.id, "add", { title: "Не сохранять" }, options(record)),
  },
  {
    name: "публикация комментария",
    /**
     * Пытается дополнить независимый журнал повреждённой задачи.
     */
    run: (record: EntityRecord): unknown => tasks.comment(record.id, "Не публиковать", "автор"),
  },
] as const;

const doneCriterionActions = [
  { name: "изменение", action: "update" },
  { name: "повторная отметка", action: "complete" },
  { name: "повторное открытие", action: "reopen" },
  { name: "удаление", action: "remove" },
  { name: "добавление", action: "add" },
] as const;

const staleTaskOperations = [
  {
    name: "неизменный заголовок",
    /**
     * Передаёт актуальный текст с устаревшей ревизией.
     */
    run: (initial: TaskRecord, current: TaskRecord): unknown =>
      tasks.update(initial.id, { title: current.data.title }, options(initial)),
  },
  {
    name: "неизменный родитель",
    /**
     * Повторяет отсутствие родителя с устаревшей ревизией.
     */
    run: (initial: TaskRecord): unknown => tasks.setParent(initial.id, null, options(initial)),
  },
  {
    name: "неизменная колонка",
    /**
     * Повторяет текущую колонку с устаревшей ревизией.
     */
    run: (initial: TaskRecord): unknown =>
      tasks.move(initial.id, { column: "inbox" }, options(initial)),
  },
] as const;

const brokenTaskReferenceReads = [
  {
    name: "расчёт прогресса",
    /**
     * Запрашивает обязательства задачи с отсутствующей зависимостью.
     */
    run: (record: TaskRecord): unknown => tasks.progress(record.id),
  },
  {
    name: "отбор готовых задач",
    /**
     * Запрашивает готовность в графе с отсутствующей зависимостью.
     */
    run: (_record: TaskRecord): unknown => tasks.list({ readiness: "ready" }),
  },
] as const;

let directory: string;
let db: ProjectDatabase;
let knowledge: KnowledgeService;
let tasks: TasksService;
let connections: ProjectDatabase[];

/**
 * Передаёт ревизию подготовленной записи без автоматического обновления CAS.
 */
function options(record: EntityRecord): WriteOptions {
  return { actor: "исполнитель", ifRevision: record.revision };
}

/**
 * Проверяет тип и предметный код отказа; сохранность данных проверяется в сценарии.
 */
async function errorCode(operation: () => unknown, expected: string): Promise<void> {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RelayError);
  expect(failure).toMatchObject({ code: expected });
}

/**
 * Создаёт задачу в базе текущего теста; значимые поля задаёт вызывающий сценарий.
 */
function task(title: string, input: Record<string, unknown> = {}): Promise<TaskRecord> {
  return tasks.create({ title, ...input }, "автор");
}

/**
 * Создаёт приложение с автоматически принадлежащей ему доской в базе текущего теста.
 */
async function applicationBoard(slug = "web"): Promise<ApplicationBoardFixture> {
  const application = await knowledge.create("application", { name: slug, slug }, "автор");
  const board = knowledge.get("board", application.data.boardId);
  return { application, board };
}

/**
 * Возвращает первый критерий подготовленной задачи; отсутствие критерия — ошибка fixture.
 */
function firstCriterion(record: TaskRecord): TaskCriterion {
  const criterion = record.data.acceptanceCriteria[0];
  if (!criterion) {
    throw new Error("В подготовленной задаче отсутствует критерий");
  }
  return criterion;
}

/**
 * Создаёт задачу с выполненным критерием и полными текстами в колонке review.
 * Возвращает ревизию после отметки; задача остаётся открытой для изменения критерия.
 */
async function taskWithCompletedCriterion(): Promise<TaskRecord> {
  const record = await task("Приёмка", {
    column: "review",
    acceptanceCriteria: [
      { title: "Результат", summary: "Кратко", description: "## Проверка\nПолное условие" },
    ],
  });
  return tasks.criterion(record.id, "complete", { id: firstCriterion(record).id }, options(record));
}

beforeEach(() => {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "git-sync-implementation/commands/tasks",
  );
  mkdirSync(artifacts, { recursive: true });
  directory = mkdtempSync(join(artifacts, "tasks-fixture-"));
  db = ProjectDatabase.create(join(directory, "project.sqlite"), {
    id: crypto.randomUUID(),
    name: "Задачи",
    slug: "tasks",
  });
  connections = [db];
  knowledge = new KnowledgeService(db);
  tasks = new TasksService(db);
});

afterEach(() => {
  for (const connection of connections.toReversed()) {
    connection.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("Адреса и чтение задач в SQLite", () => {
  test("типизированные ссылки доски разрешаются при создании, списке и переносе задачи", async () => {
    const { board } = await applicationBoard();
    const initial = await task("Ссылка на продукт", { board: "board:product" });

    expect(tasks.list({ board: "board:BOARD-PRODUCT" })).toEqual([initial]);

    const moved = await tasks.move(initial.id, { board: `board:${board.id}` }, options(initial));

    expect(moved.data.boardId).toBe(board.id);
    expect(tasks.list({ board: "board:web" })).toEqual([moved]);
    expect(tasks.get(initial.key)).toEqual(moved);
  });

  test("ссылка на приложение вместо доски отклоняет создание без записи", async () => {
    await applicationBoard();
    const generation = db.getGeneration();

    await errorCode(() => task("Неверный вид", { board: "application:web" }), "INVALID_ARGUMENT");

    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("ссылка на задачу вместо доски отклоняет перенос без записи", async () => {
    const original = await task("Исходная задача");
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.move(original.id, { board: `task:${original.id}` }, options(original)),
      "INVALID_ARGUMENT",
    );

    expect(tasks.list()).toEqual([original]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("progressMany вычисляет несколько задач по постоянным ID одним чтением графа", async () => {
    const dependency = await task("Готовое обязательство", { column: "done" });
    const parent = await task("Итог", { column: "done", dependencies: [dependency.id] });
    const child = await task("Дочерняя работа", { column: "done", parent: parent.id });
    const { board } = await applicationBoard();
    await tasks.move(parent.id, { board: board.id }, options(parent));
    await tasks.move(dependency.id, { column: "review" }, options(dependency));
    const readGraph = spyOn(db, "listTaskGraph");
    const readAll = spyOn(db, "list");
    const readIdentity = spyOn(db, "getIdentity");
    try {
      const progress = tasks.progressMany([
        // Прежний ключ стал алиасом, повтор той же строки не должен повторять чтение.
        parent.key,
        `task:${child.id}`,
        dependency.id,
        parent.id,
        parent.key,
        `task:${child.id}`,
      ]);

      expect(progress).toEqual(
        new Map([
          [parent.id, { completed: false, canComplete: false, blockers: [dependency.id] }],
          [child.id, { completed: true, canComplete: true, blockers: [] }],
          [dependency.id, { completed: false, canComplete: true, blockers: [] }],
        ]),
      );
      expect(readGraph).toHaveBeenCalledTimes(1);
      expect(readAll).not.toHaveBeenCalled();
      expect(readIdentity).toHaveBeenCalledTimes(4);
    } finally {
      readGraph.mockRestore();
      readAll.mockRestore();
      readIdentity.mockRestore();
    }
  });

  test("get возвращает карточку из снимка разрешения ссылки при конкурентном изменении", async () => {
    const original = await task("Исходное содержание");
    const peer = ProjectDatabase.open(db.path);
    connections.push(peer);
    const readIdentity = db.getIdentity.bind(db);
    const current: TaskRecord = {
      ...original,
      revision: original.revision + 1,
      data: { ...original.data, title: "Новая версия" },
    };
    const identityRead = spyOn(db, "getIdentity").mockImplementation((ref, kind) => {
      const identity = readIdentity(ref, kind);
      // Коммит попадает строго между разрешением адреса и чтением полной карточки.
      peer.update(current, original.revision);
      return identity;
    });
    try {
      const snapshot = tasks.get(`task:${original.key}`);

      expect(snapshot).toEqual(original);
      expect(current).toMatchObject({
        revision: original.revision + 1,
        data: { title: "Новая версия" },
      });
    } finally {
      identityRead.mockRestore();
    }
    expect(tasks.get(original.id)).toEqual(current);
  });

  test("неоднозначный виртуальный адрес доски отклоняет создание задачи без записи", async () => {
    const first = await applicationBoard();
    const second = await applicationBoard("api");
    // Намеренная порча адреса через Storage обходит штатную уникальность Knowledge.
    db.update(
      {
        ...second.board,
        revision: second.board.revision + 1,
        data: { ...second.board.data, slug: first.board.data.slug },
      },
      second.board.revision,
    );
    const generation = db.getGeneration();

    await errorCode(() => task("Не сохранять", { board: "board:web" }), "CORRUPT_DATA");

    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
  });

  test.each(corruptedDependencyOperations)(
    "повреждённые зависимости: $name отклоняется без изменения состояния",
    async ({ run }) => {
      const original = await task("Повреждение");
      const target = await task("Связанная задача");
      // Намеренно обходим предметный сервис: воспроизводим повреждённый JSON в Storage.
      db.update(
        {
          ...original,
          revision: original.revision + 1,
          data: { ...original.data, dependencies: null },
        },
        original.revision,
      );
      const damaged = db.get(original.id);
      if (!damaged) {
        throw new Error("Fixture повреждённой задачи не найден");
      }
      const generation = db.getGeneration();

      await errorCode(() => run(damaged, target), "CORRUPT_DATA");

      expect(db.get(original.id)).toEqual(damaged);
      expect(db.getGeneration()).toBe(generation);
      expect(tasks.get(target.id)).toEqual(target);
    },
  );

  test("progressMany проверяет обязательства независимо от текстовых полей полной карточки", async () => {
    const record = await task("Готовая задача", { column: "done" });
    // Намеренное повреждение содержания: графу оно не нужно, полная карточка обязана отказать.
    db.update(
      { ...record, revision: record.revision + 1, data: { ...record.data, description: null } },
      record.revision,
    );

    const progress = tasks.progressMany([record.key]).get(record.id);

    expect(progress).toEqual({
      completed: true,
      canComplete: true,
      blockers: [],
    });
    await errorCode(() => tasks.get(record.id), "CORRUPT_DATA");
  });

  test.each(taskPageCases)(
    "$name сохраняет total и состав окна",
    async ({ filter, offset, sort, item, total }) => {
      const parent = await task("Родитель");
      const last = await task("Ясный итог", { parent: parent.id });
      await task("Актуальная работа", { parent: parent.id });
      await task("Посторонняя задача");
      const filters = { all: {}, key: { parent: parent.key }, id: { parent: parent.id } };
      const expectedItems = { parent: [parent], last: [last], empty: [] };

      const page = tasks.listPage(filters[filter], { offset, limit: 1, sort });

      expect(page).toEqual({ items: expectedItems[item], total });
    },
  );

  test("графовая проекция отличает отсутствующий parentId от допустимого null", async () => {
    const record = await task("Задача без родителя", { column: "done" });
    expect(tasks.progressMany([record.id]).get(record.id)?.completed).toBe(true);
    // Намеренно удаляем обязательное поле в Storage, а не снимаем родителя через Core.
    const data: Record<string, unknown> = { ...record.data };
    delete data.parentId;
    const damaged = { ...record, revision: record.revision + 1, data };
    db.update(damaged, record.revision);
    const generation = db.getGeneration();

    await errorCode(() => tasks.progressMany([record.id]), "CORRUPT_DATA");

    expect(db.get(record.id)).toEqual(damaged);
    expect(db.getGeneration()).toBe(generation);
  });

  test("вычисленная и SQL-страницы одинаково сортируют Unicode-заголовки", async () => {
    const later = await task("🙂 Итог");
    const earlier = await task("\uE000 Начало");
    const window = { offset: 0, limit: 2, sort: "title" } as const;

    const sqlPage = tasks.listPage({}, window);
    const computedPage = tasks.listPage({ q: "" }, window);

    expect(sqlPage.items).toEqual([earlier, later]);
    expect(computedPage.items).toEqual([earlier, later]);
  });

  test("создание с невыполненным критерием в done откатывает задачу, счётчик и поколение", async () => {
    const generation = db.getGeneration();

    await errorCode(
      () =>
        task("Нельзя завершить", { column: "done", acceptanceCriteria: [{ title: "Проверка" }] }),
      "TASK_INCOMPLETE",
    );

    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
    expect(await tasks.create({}, "автор")).toMatchObject({
      key: "PRODUCT-1",
      revision: 1,
      data: { title: "", description: "", column: "inbox" },
    });
  });
});

describe("Обязательства и циклы задач", () => {
  test("зависимость ребёнка от родителя отклоняется без изменения графа", async () => {
    const parent = await task("Родитель");
    const child = await task("Ребёнок", { parent: parent.key });
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.dependency(child.id, parent.id, false, options(child)),
      "TASK_CYCLE",
    );

    expect(tasks.list()).toEqual([parent, child]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("назначение ребёнка родителем предка отклоняется без изменения графа", async () => {
    const parent = await task("Родитель");
    const child = await task("Ребёнок", { parent: parent.key });
    const generation = db.getGeneration();

    await errorCode(() => tasks.setParent(parent.id, child.id, options(parent)), "TASK_CYCLE");

    expect(tasks.list()).toEqual([parent, child]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("назначение себя родителем отклоняется без изменения задачи", async () => {
    const parent = await task("Родитель");
    const generation = db.getGeneration();

    await errorCode(() => tasks.setParent(parent.id, parent.id, options(parent)), "TASK_CYCLE");

    expect(tasks.get(parent.id)).toEqual(parent);
    expect(db.getGeneration()).toBe(generation);
  });

  test("зависимость от себя отклоняется без изменения задачи", async () => {
    const parent = await task("Родитель");
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.dependency(parent.id, parent.id, false, options(parent)),
      "INVALID_ARGUMENT",
    );

    expect(tasks.get(parent.id)).toEqual(parent);
    expect(db.getGeneration()).toBe(generation);
  });

  test("цикл через родителя и внешнюю зависимость отклоняется без изменения графа", async () => {
    const parent = await task("Родитель");
    const child = await task("Ребёнок", { parent: parent.id });
    const dependency = await task("Внешняя зависимость", { dependencies: [parent.id] });
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.dependency(child.id, dependency.id, false, options(child)),
      "TASK_CYCLE",
    );

    expect(tasks.list()).toEqual([parent, child, dependency]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("встречные зависимости отклоняются без изменения графа", async () => {
    const parent = await task("Исходная задача");
    const dependency = await task("Зависимая задача", { dependencies: [parent.id] });
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.dependency(parent.id, dependency.id, false, options(parent)),
      "TASK_CYCLE",
    );

    expect(tasks.list()).toEqual([parent, dependency]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("взаимные информационные связи не добавляют обязательств к родительскому графу", async () => {
    let parent = await task("Родитель");
    const child = await task("Ребёнок", { parent: parent.id });

    parent = await tasks.related(parent.id, child.id, false, options(parent));
    const relatedChild = await tasks.related(child.id, parent.id, false, options(child));

    expect(tasks.progress(relatedChild.id).canComplete).toBe(true);
    expect(tasks.progress(parent.id).blockers).toEqual([child.id]);
    expect(parent.data.related).toEqual([child.id]);
    expect(relatedChild.data.related).toEqual([parent.id]);
  });

  test("повторное открытие зависимости транзитивно снимает выполнение без переноса колонок", async () => {
    let leaf = await task("Результат", { column: "done" });
    const middle = await task("Промежуточная", { column: "done", dependencies: [leaf.key] });
    const root = await task("Итог", { column: "done", dependencies: [middle.id] });
    expect(tasks.progress(root.id)).toEqual({ completed: true, canComplete: true, blockers: [] });

    leaf = await tasks.move(leaf.id, { column: "review" }, options(leaf));

    expect(tasks.progress(root.id)).toEqual({
      completed: false,
      canComplete: false,
      blockers: [middle.id],
    });
    expect(tasks.progress(middle.id).blockers).toEqual([leaf.id]);
    expect(tasks.get(root.id)).toMatchObject({ revision: root.revision, data: { column: "done" } });

    leaf = await tasks.move(leaf.id, { column: "cancelled" }, options(leaf));

    expect(tasks.progress(leaf.id)).toEqual({ completed: false, canComplete: true, blockers: [] });
    expect(tasks.progress(root.id).completed).toBe(false);

    await tasks.move(leaf.id, { column: "done" }, options(leaf));

    expect(tasks.progress(root.id).completed).toBe(true);
  });

  test("ребёнок обязателен без отдельной зависимости; done-родитель требует завершённого нового ребёнка", async () => {
    let parent = await task("Родитель", { column: "done" });
    const generation = db.getGeneration();

    await errorCode(() => task("Новая работа", { parent: parent.id }), "TASK_DONE");

    expect(tasks.list()).toEqual([parent]);
    expect(db.getGeneration()).toBe(generation);
    let child = await task("Готовый ребёнок", { parent: parent.id, column: "done" });
    expect(tasks.progress(parent.id).completed).toBe(true);

    child = await tasks.move(child.id, { column: "in-progress" }, options(child));

    expect(tasks.progress(parent.id).blockers).toEqual([child.id]);
    expect(tasks.children(parent.key).map((item) => item.id)).toEqual([child.id]);
    const another = await task("Другой ребёнок");
    const beforeReparent = db.getGeneration();

    await errorCode(() => tasks.setParent(another.id, parent.id, options(another)), "TASK_DONE");

    expect(tasks.get(another.id)).toEqual(another);
    expect(tasks.get(parent.id)).toEqual(parent);
    expect(db.getGeneration()).toBe(beforeReparent);

    parent = await tasks.move(parent.id, { column: "in-progress" }, options(parent));
    await tasks.setParent(another.id, parent.id, options(another));

    expect(tasks.progress(parent.id).blockers).toHaveLength(2);

    await tasks.setParent(child.id, null, options(child));

    expect(tasks.progress(parent.id).blockers).toEqual([another.id]);
  });
});

describe("Критерии приёмки задач", () => {
  test("пакет update → complete принимает новый текст критерия отдельной отметкой", async () => {
    const current = await taskWithCompletedCriterion();
    const criterion = firstCriterion(current);
    const commit = spyOn(db.commands, "commit");
    try {
      const result = await new CommandExecutor(db).executeCommands(
        [
          {
            op: "task.criterion.update",
            ref: current.id,
            ifRevision: current.revision,
            input: { id: criterion.id, title: "Новые условия приёмки" },
            as: "updated",
          },
          {
            op: "task.criterion.complete",
            ref: current.id,
            ifRevision: { $revision: "updated" },
            input: { id: criterion.id },
          },
        ],
        { actor: "новый рецензент" },
      );

      const stored = tasks.get(current.id);
      expect(stored.revision).toBe(current.revision + 2);
      expect(firstCriterion(stored)).toEqual({
        ...criterion,
        title: "Новые условия приёмки",
        completed: true,
        completedBy: "новый рецензент",
        completedAt: expect.any(String),
      });
      expect(result.entities).toEqual([stored]);
      expect(commit).toHaveBeenCalledTimes(1);
      const transitions = commit.mock.calls[0]?.[0].transitions;
      expect(transitions).toHaveLength(2);
      expect(transitions?.[0]?.effects).toEqual([
        expect.objectContaining({
          kind: "entity",
          after: expect.objectContaining({
            data: expect.objectContaining({
              acceptanceCriteria: [
                {
                  ...criterion,
                  title: "Новые условия приёмки",
                  completed: false,
                  completedAt: null,
                  completedBy: null,
                },
              ],
            }),
          }),
        }),
      ]);
    } finally {
      commit.mockRestore();
    }
  });

  test("невыполненный критерий запрещает завершение без изменения задачи", async () => {
    const record = await task("Приёмка", {
      acceptanceCriteria: [
        { title: "Результат", summary: "Кратко", description: "## Проверка\nПолное условие" },
      ],
    });
    const id = firstCriterion(record).id;
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.move(record.id, { column: "done" }, options(record)),
      "TASK_INCOMPLETE",
    );

    expect(tasks.getCriterion(record.id, id).completed).toBe(false);
    expect(tasks.get(record.id)).toEqual(record);
    expect(db.getGeneration()).toBe(generation);
  });

  test("отметка критерия сохраняет автора и дату, делая открытую задачу готовой к завершению", async () => {
    const record = await task("Приёмка", {
      column: "review",
      acceptanceCriteria: [{ title: "Результат" }],
    });
    const id = firstCriterion(record).id;

    const updated = await tasks.criterion(
      record.id,
      "complete",
      { criterionId: id },
      options(record),
    );

    const completed = tasks.getCriterion(record.id, id);
    expect(completed).toMatchObject({ completed: true, completedBy: "исполнитель" });
    expect(completed.completedAt).not.toBeNull();
    expect(updated.revision).toBe(record.revision + 1);
    expect(tasks.progress(record.id)).toEqual({
      completed: false,
      canComplete: true,
      blockers: [],
    });
  });

  test("неизменный текст выполненного критерия сохраняет отметку и ревизию", async () => {
    const record = await taskWithCompletedCriterion();
    const completed = firstCriterion(record);
    const generation = db.getGeneration();

    const sameText = await tasks.criterion(
      record.id,
      "update",
      { id: completed.id, description: completed.description },
      options(record),
    );

    expect(sameText.revision).toBe(record.revision);
    expect(tasks.getCriterion(record.id, completed.id)).toEqual(completed);
    expect(db.getGeneration()).toBe(generation);
  });

  test("изменение текста критерия сбрасывает отметку, автора и дату до повторной приёмки", async () => {
    const record = await taskWithCompletedCriterion();
    const previous = firstCriterion(record);
    const id = previous.id;

    const updated = await tasks.criterion(
      record.id,
      "update",
      { id, summary: "Другое условие" },
      options(record),
    );

    expect(tasks.getCriterion(record.id, id)).toEqual({
      ...previous,
      summary: "Другое условие",
      completed: false,
      completedAt: null,
      completedBy: null,
    });
    expect(updated.revision).toBe(record.revision + 1);

    const acceptedAgain = await tasks.criterion(record.id, "complete", { id }, options(updated));

    expect(firstCriterion(acceptedAgain)).toMatchObject({
      summary: "Другое условие",
      completed: true,
      completedBy: "исполнитель",
    });
  });

  test("правка summary при повреждённом заголовке критерия отклоняется без записи", async () => {
    const record = await task("Приёмка", { acceptanceCriteria: [{ title: "Проверка" }] });
    const criterion = firstCriterion(record);
    // Пустой заголовок нельзя создать через Core: моделируем повреждение сохранённого JSON.
    const corrupted = {
      ...record,
      revision: record.revision + 1,
      data: { ...record.data, acceptanceCriteria: [{ ...criterion, title: "" }] },
    };
    db.update(corrupted, record.revision);
    const generation = db.getGeneration();

    await errorCode(
      () =>
        tasks.criterion(
          record.id,
          "update",
          { id: criterion.id, summary: "Новое пояснение" },
          options(corrupted),
        ),
      "CORRUPT_DATA",
    );

    expect(db.get(record.id)).toEqual(corrupted);
    expect(db.getGeneration()).toBe(generation);
    await errorCode(() => tasks.get(record.id), "CORRUPT_DATA");
  });

  test("повторное открытие критерия снимает готовность задачи до новой отметки", async () => {
    const record = await taskWithCompletedCriterion();
    const id = firstCriterion(record).id;

    const reopened = await tasks.criterion(record.id, "reopen", { id }, options(record));

    expect(tasks.progress(record.id).canComplete).toBe(false);
    expect(firstCriterion(reopened)).toMatchObject({
      completed: false,
      completedAt: null,
      completedBy: null,
    });

    await tasks.criterion(record.id, "complete", { id }, options(reopened));

    expect(tasks.progress(record.id)).toEqual({
      completed: false,
      canComplete: true,
      blockers: [],
    });
  });

  test.each(doneCriterionActions)(
    "в done $name критерия отклоняется без изменения задачи",
    async ({ action }) => {
      let record = await taskWithCompletedCriterion();
      const id = firstCriterion(record).id;
      record = await tasks.move(record.id, { column: "done" }, options(record));
      const generation = db.getGeneration();
      const input = action === "add" ? { title: "Новое" } : { id };
      if (action === "update") {
        Object.assign(input, { title: "Иное" });
      }

      await errorCode(
        () => tasks.criterion(record.id, action, input, options(record)),
        "TASK_DONE",
      );

      expect(tasks.get(record.id)).toEqual(record);
      expect(db.getGeneration()).toBe(generation);
    },
  );

  test("после повторного открытия задачи удаление и добавление критерия не переиспользует ID", async () => {
    let record = await taskWithCompletedCriterion();
    const id = firstCriterion(record).id;
    record = await tasks.move(record.id, { column: "done" }, options(record));

    record = await tasks.move(record.id, { column: "ready" }, options(record));
    record = await tasks.criterion(record.id, "remove", { id }, options(record));
    record = await tasks.criterion(record.id, "add", { title: "Следующий" }, options(record));

    expect(firstCriterion(record).id).not.toBe(id);
    expect(tasks.criteria(record.id)).toEqual(record.data.acceptanceCriteria);
    expect(tasks.get(record.id).revision).toBe(record.revision);
  });
});

describe("Отбор и цели задач", () => {
  test("readiness отделяет доступную работу от задач с невыполненными обязательствами", async () => {
    const dependency = await task("Зависимость");
    const ready = await task("Можно начать", {
      column: "ready",
      acceptanceCriteria: [{ title: "Ещё не проверено" }],
    });
    const blocked = await task("Заблокировано", { column: "ready", dependencies: [dependency.id] });
    await task("Отменено", { column: "cancelled" });
    await task("Завершено", { column: "done" });

    const readyTasks = tasks.list({ readiness: "ready" });
    const blockedTasks = tasks.list({ readiness: "blocked" });

    expect(readyTasks.map((item) => item.id)).toEqual([ready.id]);
    expect(blockedTasks.map((item) => item.id)).toEqual([blocked.id]);
    expect(TASK_COLUMNS).toHaveLength(6);
  });

  test("completion считает сохранённые done и cancelled завершёнными, остальные задачи — открытыми", async () => {
    const dependency = await task("Зависимость");
    const ready = await task("Готовая к работе", { column: "ready" });
    const blocked = await task("Заблокированная", {
      column: "ready",
      dependencies: [dependency.id],
    });
    const cancelled = await task("Отменено", { column: "cancelled" });
    const completed = await task("Завершено", { column: "done" });

    const finished = tasks.list({ completion: "finished" });
    const unfinished = tasks.list({ completion: "unfinished" });

    expect(finished.map((item) => item.id)).toEqual([cancelled.id, completed.id]);
    expect(unfinished).toEqual([dependency, ready, blocked]);
  });

  test("поиск по всему содержанию находит Markdown, который отсутствует в заголовке", async () => {
    const record = await task("Работа", { description: "Уникальный Markdown" });

    const titleMatches = tasks.list({ q: "markdown", searchIn: "title" });
    const contentMatches = tasks.list({ q: "markdown", searchIn: "all", board: "PRODUCT" });

    expect(titleMatches).toEqual([]);
    expect(contentMatches.map((item) => item.id)).toEqual([record.id]);
  });

  test("фильтр parent null возвращает только задачи без родителя", async () => {
    const parent = await task("Корневая задача");
    await task("Дочерняя задача", { parent: parent.id });

    const roots = tasks.list({ parent: null });

    expect(roots).toEqual([parent]);
  });

  test("реализация приложения не назначается целью задачи продуктовой доски", async () => {
    const feature = await knowledge.create("feature", { name: "Возможность" }, "автор");
    const { application } = await applicationBoard();
    const implementation = await knowledge.create(
      "implementation",
      { application: application.id, target: feature.id, title: "Реализация" },
      "автор",
    );
    const generation = db.getGeneration();

    await errorCode(
      () => task("Неверная цель", { targets: [implementation.id] }),
      "INVALID_ARGUMENT",
    );

    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("продуктовая возможность не назначается целью задачи доски приложения", async () => {
    const feature = await knowledge.create("feature", { name: "Возможность" }, "автор");
    const { board } = await applicationBoard();
    const generation = db.getGeneration();

    await errorCode(
      () => task("Неверная цель", { board: board.id, targets: [feature.id] }),
      "INVALID_ARGUMENT",
    );

    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("реализация чужого приложения не назначается целью задачи своей доски", async () => {
    const feature = await knowledge.create("feature", { name: "Возможность" }, "автор");
    const { board } = await applicationBoard();
    const foreign = await applicationBoard("api");
    const foreignImplementation = await knowledge.create(
      "implementation",
      { application: foreign.application.id, target: feature.id, title: "Чужая реализация" },
      "автор",
    );
    const generation = db.getGeneration();

    await errorCode(
      () => task("Чужая цель", { board: board.id, targets: [foreignImplementation.id] }),
      "INVALID_ARGUMENT",
    );

    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("повтор цели через ID и ключ отклоняется без создания задачи", async () => {
    const feature = await knowledge.create("feature", { name: "Возможность" }, "автор");
    const generation = db.getGeneration();

    await errorCode(
      () => task("Дубликат", { targets: [feature.id, feature.key] }),
      "INVALID_ARGUMENT",
    );

    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("несовместимая цель запрещает перенос доски до явного снятия назначения", async () => {
    const feature = await knowledge.create("feature", { name: "Возможность" }, "автор");
    const { board } = await applicationBoard();
    let productTask = await task("Общая работа", { targets: [feature.key] });
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.move(productTask.id, { board: board.id }, options(productTask)),
      "INVALID_ARGUMENT",
    );

    expect(tasks.get(productTask.id)).toEqual(productTask);
    expect(db.getGeneration()).toBe(generation);

    productTask = await tasks.update(productTask.id, { targets: [] }, options(productTask));
    productTask = await tasks.move(productTask.id, { board: board.id }, options(productTask));

    expect(productTask.data.targets).toEqual([]);
    expect(productTask.data.boardId).toBe(board.id);
  });

  test("снятая реализация запрещает новые назначения и сохраняется в прежней задаче", async () => {
    const feature = await knowledge.create("feature", { name: "Возможность" }, "автор");
    const { application, board } = await applicationBoard();
    const implementation = await knowledge.create(
      "implementation",
      { application: application.id, target: feature.id, title: "Реализация" },
      "автор",
    );
    const appTask = await task("Реализация", { board: board.id, targets: [implementation.key] });
    expect(appTask.data.targets).toEqual([implementation.id]);
    await knowledge.replaceParticipation(
      application.id,
      [],
      options(knowledge.get("application", application.id)),
    );
    const generation = db.getGeneration();

    await errorCode(
      () => task("Снятая цель", { board: board.id, targets: [implementation.id] }),
      "INVALID_ARGUMENT",
    );

    expect(tasks.list()).toEqual([appTask]);
    expect(db.getGeneration()).toBe(generation);

    const unchanged = await tasks.update(
      appTask.id,
      { targets: [implementation.id] },
      options(appTask),
    );
    const moved = await tasks.move(appTask.id, { column: "review" }, options(appTask));

    expect(unchanged.revision).toBe(appTask.revision);
    expect(moved.data.targets).toEqual([implementation.id]);
  });

  test("productTarget раскрывает сценарии и активные реализации, target выбирает только прямую цель", async () => {
    const feature = await knowledge.create("feature", { name: "Возможность" }, "автор");
    const scenario = await knowledge.create(
      "scenario",
      { name: "Сценарий", feature: feature.id },
      "автор",
    );
    const { application, board } = await applicationBoard();
    const featureImplementation = await knowledge.create(
      "implementation",
      { application: application.id, target: feature.id, title: "Реализация фичи" },
      "автор",
    );
    const implementation = await knowledge.create(
      "implementation",
      { application: application.id, target: scenario.id, title: "Реализация сценария" },
      "автор",
    );
    const direct = await task("Продукт", { targets: [feature.id] });
    const scenarioTask = await task("Сценарий", { targets: [scenario.id] });
    const implementationTask = await task("Приложение", {
      board: board.id,
      targets: [implementation.id],
    });
    const featureImplementationTask = await task("Фича приложения", {
      board: board.id,
      targets: [featureImplementation.id],
    });

    const directTargets = tasks.list({ target: feature.id });
    const productTargets = tasks.list({ productTarget: feature.key });
    const implementationTargets = tasks.list({ productTarget: featureImplementation.id });

    expect(directTargets.map((item) => item.id)).toEqual([direct.id]);
    expect(new Set(productTargets.map((item) => item.id))).toEqual(
      new Set([direct.id, scenarioTask.id, implementationTask.id, featureImplementationTask.id]),
    );
    expect(new Set(implementationTargets.map((item) => item.id))).toEqual(
      new Set([featureImplementationTask.id, implementationTask.id]),
    );

    await knowledge.replaceParticipation(
      application.id,
      [feature.id],
      options(knowledge.get("application", application.id)),
    );

    expect(tasks.list({ productTarget: scenario.id }).map((item) => item.id)).toEqual([
      scenarioTask.id,
    ]);
  });

  test("перенос сохраняет ID, связи, алиасы и ровно одну новую ревизию", async () => {
    const { board } = await applicationBoard();
    let record = await task("Переносимая");
    const oldKey = record.key;
    const dependant = await task("Потребитель", { dependencies: [record.key] });

    record = await tasks.move(
      oldKey,
      { board: board.data.slug, column: "review" },
      options(record),
    );

    expect(record).toMatchObject({
      key: "WEB-1",
      revision: 2,
      data: { boardId: board.id, column: "review" },
    });
    expect(tasks.get(oldKey)).toEqual(record);
    expect(tasks.dependencies(dependant.id).map((dependency) => dependency.id)).toEqual([
      record.id,
    ]);
    const movedKey = record.key;

    record = await tasks.move(record.id, { board: "product" }, options(record));

    expect(record.key).toBe("PRODUCT-3");
    expect(record.revision).toBe(3);
    expect(tasks.get(movedKey).id).toBe(record.id);
    expect(tasks.get(oldKey).key).toBe(record.key);
    const fresh = await task("Новая", { board: board.id });
    expect(fresh.key).toBe("WEB-2");
  });
});

describe("Ревизии и независимый журнал задач", () => {
  test("пакет завершения и позднего переоткрытия обязательства сохраняет историю переходов", async () => {
    const dependency = await task("Обязательство", { column: "done" });
    const parent = await task("Итог", { column: "review", dependencies: [dependency.id] });
    const load = spyOn(db.commands, "load");
    try {
      const result = await new CommandExecutor(db).executeCommands(
        [
          {
            op: "task.move",
            ref: parent.id,
            ifRevision: parent.revision,
            input: { column: "done" },
          },
          {
            op: "task.move",
            ref: dependency.id,
            ifRevision: dependency.revision,
            input: { column: "ready" },
          },
        ],
        { actor: "исполнитель" },
      );

      expect(result.status).toBe("committed");
      expect(tasks.get(parent.id)).toMatchObject({
        revision: parent.revision + 1,
        data: { column: "done" },
      });
      expect(tasks.get(dependency.id)).toMatchObject({
        revision: dependency.revision + 1,
        data: { column: "ready" },
      });
      expect(tasks.progress(parent.id)).toEqual({
        completed: false,
        canComplete: false,
        blockers: [dependency.id],
      });
      expect(
        load.mock.calls
          .flatMap(([request]) => request.selectors)
          .filter((selector) => selector.kind === "task-graph"),
      ).toHaveLength(1);
    } finally {
      load.mockRestore();
    }
  });

  test("после изменения overlay граф не разрешает повторное done по старой готовности", async () => {
    const dependency = await task("Обязательство", { column: "done" });
    const parent = await task("Итог", { column: "review", dependencies: [dependency.id] });
    const generation = db.getGeneration();

    await errorCode(
      () =>
        new CommandExecutor(db).executeCommands(
          [
            {
              op: "task.move",
              ref: parent.id,
              ifRevision: parent.revision,
              input: { column: "done" },
              as: "completed",
            },
            {
              op: "task.move",
              ref: dependency.id,
              ifRevision: dependency.revision,
              input: { column: "ready" },
            },
            {
              op: "task.move",
              ref: parent.id,
              ifRevision: { $revision: "completed" },
              input: { column: "done" },
            },
          ],
          { actor: "исполнитель" },
        ),
      "TASK_INCOMPLETE",
    );

    expect(tasks.get(parent.id)).toEqual(parent);
    expect(tasks.get(dependency.id)).toEqual(dependency);
    expect(db.getGeneration()).toBe(generation);
  });

  test.each(["task.update", "task.criterion.complete", "task.comment.add"] as const)(
    "%s читает только владельца без графа и каталога задач",
    async (op) => {
      const current = await task("До изменения", { acceptanceCriteria: [{ title: "Проверка" }] });
      const criterion = firstCriterion(current);
      const inputs = {
        "task.update": { title: "Новый заголовок" },
        "task.criterion.complete": { id: criterion.id },
        "task.comment.add": { body: "Обсуждение" },
      };
      const expectedData = {
        "task.update": { title: "Новый заголовок" },
        "task.criterion.complete": {
          acceptanceCriteria: [expect.objectContaining({ id: criterion.id, completed: true })],
        },
        "task.comment.add": { comments: [expect.objectContaining({ body: "Обсуждение" })] },
      };
      const load = spyOn(db.commands, "load");
      try {
        const result = await new CommandExecutor(db).execute(
          {
            op,
            ref: current.id,
            input: inputs[op],
            ...(op === "task.comment.add" ? {} : { ifRevision: current.revision }),
          },
          { actor: "исполнитель" },
        );

        expect(result.entities).toEqual([
          expect.objectContaining({
            id: current.id,
            data: expect.objectContaining(expectedData[op]),
          }),
        ]);
        const selectors = load.mock.calls.flatMap(([request]) => request.selectors);
        expect(
          selectors.filter(
            (selector) => selector.kind === "task-graph" || selector.kind === "kind",
          ),
        ).toEqual([]);
        expect(
          selectors
            .filter((selector) => selector.kind === "entity")
            .map((selector) => selector.ref),
        ).toEqual([current.id]);
        if (op === "task.comment.add") {
          expect(selectors.find((selector) => selector.kind === "entity")).toMatchObject({
            semantic: "existence",
          });
        }
      } finally {
        load.mockRestore();
      }
    },
  );

  test.each(staleTaskOperations)(
    "устаревшая ревизия: $name отклоняется без изменения актуальной задачи",
    async ({ run }) => {
      const original = await task("Исходная");
      const peer = ProjectDatabase.open(db.path);
      connections.push(peer);
      const concurrent = await new TasksService(peer).update(
        original.id,
        { title: "Другой автор" },
        options(original),
      );
      const generation = db.getGeneration();

      await errorCode(() => run(original, concurrent), "REVISION_CONFLICT");

      expect(tasks.get(original.id)).toEqual(concurrent);
      expect(db.getGeneration()).toBe(generation);
    },
  );

  test("предварительная проверка откатывает содержание, критерии, ключи и ревизии пакета", async () => {
    const original = await task("Исходная");
    const { board } = await applicationBoard();
    const generation = db.getGeneration();

    const checked = await new CommandExecutor(db).executeCommands(
      [
        {
          op: "task.update",
          ref: original.id,
          input: { title: "Временная" },
          ifRevision: original.revision,
          as: "changed",
        },
        {
          op: "task.criterion.add",
          ref: original.id,
          input: { title: "Критерий" },
          ifRevision: { $revision: "changed" },
          as: "criterion",
        },
        {
          op: "task.move",
          ref: original.id,
          input: { board: board.id },
          ifRevision: { $revision: "criterion" },
        },
      ],
      { actor: "исполнитель", check: true },
    );

    expect(checked.status).toBe("checked");
    expect(checked.entities).toEqual([
      expect.objectContaining({
        id: original.id,
        key: "WEB-1",
        revision: original.revision + 3,
        data: expect.objectContaining({
          title: "Временная",
          acceptanceCriteria: [expect.objectContaining({ title: "Критерий" })],
        }),
      }),
    ]);
    expect(tasks.get(original.id)).toEqual(original);
    expect(db.get("WEB-1", "task")).toBeUndefined();
    expect(db.getGeneration()).toBe(generation);
    expect((await tasks.move(original.id, { board: board.id }, options(original))).key).toBe(
      "WEB-1",
    );
  });

  test("публикация комментариев append-only переживает запись со старой ревизией содержания и повторное открытие БД", async () => {
    let record = await task("Обсуждение", { column: "done" });
    const initial = record;
    const generation = db.getGeneration();

    record = await tasks.comment(
      record.key,
      "## Причина\nПодробное объяснение",
      "рецензент",
      "Проверка",
    );

    expect(record.revision).toBe(initial.revision);
    expect(record.updatedAt).toBe(initial.updatedAt);
    expect(record.updatedBy).toBe(initial.updatedBy);
    expect(db.getGeneration()).toBeGreaterThan(generation);
    expect(tasks.progress(record.id).completed).toBe(true);
    const first = tasks.comments(record.id)[0];
    if (!first) {
      throw new Error("Опубликованный комментарий не найден");
    }
    expect(first).toMatchObject({
      title: "Проверка",
      body: "## Причина\nПодробное объяснение",
      createdBy: "рецензент",
    });
    const peer = ProjectDatabase.open(db.path);
    connections.push(peer);

    await new TasksService(peer).comment(record.id, "Второе сообщение", "другой автор");
    record = await tasks.update(record.id, { title: "Уточнение" }, options(initial));

    expect(record.revision).toBe(initial.revision + 1);
    expect(tasks.comments(record.id)).toHaveLength(2);
    expect(tasks.getComment(record.id, first.id)).toEqual(first);
    db.close();
    const reopened = ProjectDatabase.open(peer.path);
    connections.push(reopened);
    expect(new TasksService(reopened).comments(record.id)).toHaveLength(2);
    expect(new TasksService(reopened).get(record.id).revision).toBe(record.revision);
  });

  test("обновление содержания не позволяет заменить append-only журнал", async () => {
    const initial = await task("Обсуждение");
    const record = await tasks.comment(initial.id, "Сохранить сообщение", "автор");
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.update(record.id, { comments: [] }, options(record)),
      "INVALID_ARGUMENT",
    );

    expect(tasks.get(record.id)).toEqual(record);
    expect(tasks.comments(record.id)).toEqual(record.data.comments);
    expect(db.getGeneration()).toBe(generation);
  });

  test("пустой комментарий отклоняется без изменения задачи и журнала", async () => {
    const record = await task("Обсуждение");
    const generation = db.getGeneration();

    await errorCode(() => tasks.comment(record.id, "  ", "автор"), "INVALID_ARGUMENT");

    expect(tasks.get(record.id)).toEqual(record);
    expect(tasks.comments(record.id)).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
  });
});

describe("Переносимые условия фасада задач", () => {
  test("version-only update не подставляет numeric CAS и отвергает старый token до no-op", async () => {
    const original = await task("Исходный заголовок");
    const current = await tasks.update(
      original.id,
      { description: "Вторая ревизия" },
      options(original),
    );
    const observed = await new CommandExecutor(db).readVersioned(current.id, "task");
    const execute = spyOn(CommandExecutor.prototype, "execute");
    try {
      const changed = await tasks.update(
        current.id,
        { title: "Переносимая правка" },
        {
          actor: "редактор",
          expectedVersion: observed.versions.aggregateVersion,
        },
      );

      expect(changed).toMatchObject({
        id: current.id,
        revision: current.revision + 1,
        updatedBy: "редактор",
        data: { title: "Переносимая правка", description: "Вторая ревизия" },
      });
      const command = execute.mock.calls[0]?.[0];
      expect(command).toMatchObject({
        op: "task.update",
        expectedVersion: observed.versions.aggregateVersion,
      });
      expect(command).not.toHaveProperty("ifRevision");
      const generation = db.getGeneration();

      await errorCode(
        () =>
          tasks.update(
            current.id,
            { title: changed.data.title },
            {
              actor: "редактор",
              expectedVersion: observed.versions.aggregateVersion,
            },
          ),
        "VERSION_CONFLICT",
      );

      expect(tasks.get(current.id)).toEqual(changed);
      expect(db.getGeneration()).toBe(generation);
    } finally {
      execute.mockRestore();
    }
  });

  test("constructor-default разрешает move, а явный token метода имеет приоритет для критерия", async () => {
    const original = await task("Условия фасада", { acceptanceCriteria: [{ title: "Проверка" }] });
    const observed = await new CommandExecutor(db).readVersioned(original.id, "task");
    const facade = new TasksService(db, {
      expectedVersion: observed.versions.aggregateVersion,
      expectedAddresses: [{ ref: original.key, expectedId: original.id }],
    });

    const moved = await facade.move(original.key, { column: "review" }, { actor: "редактор" });
    const latest = await new CommandExecutor(db).readVersioned(moved.id, "task");
    const accepted = await facade.criterion(
      moved.id,
      "complete",
      { id: firstCriterion(moved).id },
      {
        actor: "рецензент",
        expectedVersion: latest.versions.aggregateVersion,
      },
    );

    expect(moved).toMatchObject({ revision: original.revision + 1, data: { column: "review" } });
    expect(accepted.revision).toBe(original.revision + 2);
    expect(firstCriterion(accepted)).toMatchObject({ completed: true, completedBy: "рецензент" });
    const generation = db.getGeneration();
    await errorCode(
      () => facade.move(moved.id, { column: "review" }, { actor: "редактор" }),
      "VERSION_CONFLICT",
    );
    expect(tasks.get(original.id)).toEqual(accepted);
    expect(db.getGeneration()).toBe(generation);
  });

  test("parent, dependency и related передают version-only условие своего владельца", async () => {
    const parent = await task("Родитель");
    const dependency = await task("Обязательство");
    const original = await task("Подзадача");
    const executor = new CommandExecutor(db);
    const initialVersion = await executor.readVersioned(original.id, "task");

    const parented = await tasks.setParent(original.id, parent.id, {
      actor: "редактор",
      expectedVersion: initialVersion.versions.aggregateVersion,
    });
    const parentedVersion = await executor.readVersioned(original.id, "task");
    const dependent = await tasks.dependency(original.id, dependency.id, false, {
      actor: "редактор",
      expectedVersion: parentedVersion.versions.aggregateVersion,
    });
    const dependentVersion = await executor.readVersioned(original.id, "task");
    const related = await tasks.related(original.id, dependency.id, false, {
      actor: "редактор",
      expectedVersion: dependentVersion.versions.aggregateVersion,
    });

    expect(parented).toMatchObject({
      revision: original.revision + 1,
      data: { parentId: parent.id },
    });
    expect(dependent).toMatchObject({
      revision: original.revision + 2,
      data: { dependencies: [dependency.id] },
    });
    expect(related).toMatchObject({
      revision: original.revision + 3,
      data: { parentId: parent.id, dependencies: [dependency.id], related: [dependency.id] },
    });
    expect(tasks.get(original.id)).toEqual(related);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "валидный token не допускает некорректную переданную ifRevision=%s",
    async (ifRevision) => {
      const original = await task("Сохранить содержание");
      const observed = await new CommandExecutor(db).readVersioned(original.id, "task");
      const generation = db.getGeneration();

      await errorCode(
        () =>
          tasks.update(
            original.id,
            { title: "Не сохранять" },
            {
              actor: "редактор",
              expectedVersion: observed.versions.aggregateVersion,
              ifRevision,
            },
          ),
        "INVALID_ARGUMENT",
      );

      expect(tasks.get(original.id)).toEqual(original);
      expect(db.getGeneration()).toBe(generation);
    },
  );

  test("актуальный token конструктора не заменяет устаревшую числовую ревизию метода", async () => {
    const original = await task("Исходная версия");
    const current = await tasks.update(original.id, { title: "Новая версия" }, options(original));
    const observed = await new CommandExecutor(db).readVersioned(current.id, "task");
    const facade = new TasksService(db, { expectedVersion: observed.versions.aggregateVersion });
    const generation = db.getGeneration();

    await errorCode(
      () => facade.update(current.id, { title: "Не сохранять" }, options(original)),
      "REVISION_CONFLICT",
    );

    expect(tasks.get(current.id)).toEqual(current);
    expect(db.getGeneration()).toBe(generation);
  });

  test("невалидный явный token не заменяется корректным constructor-default", async () => {
    const original = await task("Сохранить содержание");
    const observed = await new CommandExecutor(db).readVersioned(original.id, "task");
    const facade = new TasksService(db, { expectedVersion: observed.versions.aggregateVersion });
    const generation = db.getGeneration();

    await errorCode(
      () =>
        facade.update(
          original.id,
          { title: "Не сохранять" },
          {
            actor: "редактор",
            expectedVersion: " ",
            ifRevision: original.revision,
          },
        ),
      "INVALID_ARGUMENT",
    );

    expect(tasks.get(original.id)).toEqual(original);
    expect(db.getGeneration()).toBe(generation);
  });

  test("version-only сохраняет запрет неизвестных полей options", async () => {
    const original = await task("Сохранить содержание");
    const observed = await new CommandExecutor(db).readVersioned(original.id, "task");
    const invalidOptions = {
      actor: "редактор",
      expectedVersion: observed.versions.aggregateVersion,
      unknownCondition: true,
    };
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.update(original.id, { title: "Не сохранять" }, invalidOptions),
      "INVALID_ARGUMENT",
    );

    expect(tasks.get(original.id)).toEqual(original);
    expect(db.getGeneration()).toBe(generation);
  });

  test("без обоих source tokens отсутствие ifRevision сохраняет прежний отказ", async () => {
    const original = await task("Сохранить содержание");
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.update(original.id, { title: "Не сохранять" }, { actor: "редактор" }),
      "INVALID_ARGUMENT",
    );

    expect(tasks.get(original.id)).toEqual(original);
    expect(db.getGeneration()).toBe(generation);
  });
});

describe("Проверка внешнего ввода задач", () => {
  test.each(invalidTaskInputs)("$name отклоняется при создании без записи", async ({ input }) => {
    const generation = db.getGeneration();

    await errorCode(() => tasks.create(input, "автор"), "INVALID_ARGUMENT");

    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("дублирование зависимости через ID и ключ отклоняется без записи", async () => {
    const record = await task("Исходная");
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.create({ dependencies: [record.id, record.key] }, "автор"),
      "INVALID_ARGUMENT",
    );

    expect(tasks.list()).toEqual([record]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("несуществующая зависимость отклоняется без изменения задачи", async () => {
    const record = await task("Исходная");
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.dependency(record.id, "PRODUCT-999", false, options(record)),
      "NOT_FOUND",
    );

    expect(tasks.get(record.id)).toEqual(record);
    expect(db.getGeneration()).toBe(generation);
  });

  test("несуществующая цель отклоняется при создании без записи", async () => {
    const generation = db.getGeneration();

    await errorCode(() => tasks.create({ targets: ["FEAT-404"] }, "автор"), "NOT_FOUND");

    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
  });

  test("неизвестное поле before отклоняет перенос без изменения задачи", async () => {
    const record = await task("Исходная");
    const generation = db.getGeneration();

    await errorCode(
      () => tasks.move(record.id, { column: "done", before: record.id }, options(record)),
      "INVALID_ARGUMENT",
    );

    expect(tasks.get(record.id)).toEqual(record);
    expect(db.getGeneration()).toBe(generation);
  });

  test.each(invalidTaskFilters)("$name отклоняется при чтении списка", async ({ input }) => {
    const record = await task("Сохранённая задача");
    const generation = db.getGeneration();

    await errorCode(() => tasks.list(input), "INVALID_ARGUMENT");

    expect(tasks.get(record.id)).toEqual(record);
    expect(db.getGeneration()).toBe(generation);
  });

  test.each(brokenTaskReferenceReads)(
    "отсутствующая зависимость: $name отклоняется без ложной готовности",
    async ({ run }) => {
      const record = await task("Повреждение");
      // Storage намеренно сохраняет отсутствующее обязательство для проверки диагностики.
      db.update(
        {
          ...record,
          revision: record.revision + 1,
          data: { ...record.data, dependencies: ["missing-task"] },
        },
        record.revision,
      );
      const corrupted = db.get(record.id);
      const generation = db.getGeneration();

      await errorCode(() => run(record), "BROKEN_REFERENCE");

      expect(db.get(record.id)).toEqual(corrupted);
      expect(db.getGeneration()).toBe(generation);
    },
  );
});
