import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RelayError, type EntityRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../../src/entities";
import { TASK_COLUMNS, TasksService } from "../../src/tasks";

let directory: string;
let db: ProjectDatabase;
let entities: EntityService;
let tasks: TasksService;
let connections: ProjectDatabase[];
let processes: ReturnType<typeof Bun.spawn>[];

function options(record: EntityRecord) {
  return { actor: "исполнитель", ifRevision: record.revision };
}

function errorCode(operation: () => unknown, expected: string): void {
  try {
    operation();
    throw new Error(`Ожидалась ошибка ${expected}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect((error as RelayError).code).toBe(expected);
  }
}

function task(title: string, input: Record<string, unknown> = {}): EntityRecord {
  return tasks.create({ title, ...input }, "автор");
}

function applicationBoard(slug = "web") {
  const application = entities.create("application", "APP", { name: slug }, "автор");
  const board = entities.create(
    "board",
    "BOARD",
    { name: slug, slug, prefix: slug.toUpperCase(), applicationId: application.id },
    "автор",
  );
  return { application, board };
}

beforeEach(() => {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(artifacts, { recursive: true });
  directory = mkdtempSync(join(artifacts, "tasks-fixture-"));
  db = ProjectDatabase.create(join(directory, "project.sqlite"), {
    id: crypto.randomUUID(),
    name: "Задачи",
    slug: "tasks",
  });
  connections = [db];
  processes = [];
  entities = new EntityService(db);
  tasks = new TasksService(db);
});

afterEach(() => {
  for (const process of processes) process.kill();
  for (const connection of connections) connection.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("TasksService с реальной SQLite", () => {
  test("создание с невыполненным критерием в done откатывает задачу, счётчик и поколение", () => {
    const generation = db.getGeneration();
    errorCode(
      () =>
        task("Нельзя завершить", { column: "done", acceptanceCriteria: [{ title: "Проверка" }] }),
      "TASK_INCOMPLETE",
    );
    expect(tasks.list()).toEqual([]);
    expect(db.getGeneration()).toBe(generation);
    expect(tasks.create({}, "автор")).toMatchObject({
      key: "PRODUCT-1",
      revision: 1,
      data: { title: "", description: "", column: "inbox" },
    });
  });

  test("запрещены циклы зависимостей, родителей и смешанные циклы; отказ не меняет ревизию", () => {
    let parent = task("Родитель");
    const child = task("Ребёнок", { parent: parent.key });
    let dependency = task("Внешняя зависимость");
    const generation = db.getGeneration();
    errorCode(() => tasks.dependency(child.id, parent.id, false, options(child)), "TASK_CYCLE");
    errorCode(() => tasks.setParent(parent.id, child.id, options(parent)), "TASK_CYCLE");
    errorCode(() => tasks.setParent(parent.id, parent.id, options(parent)), "TASK_CYCLE");
    errorCode(
      () => tasks.dependency(parent.id, parent.id, false, options(parent)),
      "INVALID_ARGUMENT",
    );
    expect(tasks.get(child.id).revision).toBe(child.revision);
    expect(db.getGeneration()).toBe(generation);

    dependency = tasks.dependency(dependency.id, parent.id, false, options(dependency));
    errorCode(() => tasks.dependency(child.id, dependency.id, false, options(child)), "TASK_CYCLE");
    errorCode(
      () => tasks.dependency(parent.id, dependency.id, false, options(parent)),
      "TASK_CYCLE",
    );
    parent = tasks.related(parent.id, child.id, false, options(parent));
    const relatedChild = tasks.related(child.id, parent.id, false, options(child));
    expect(tasks.progress(relatedChild.id).canComplete).toBe(true);
    expect(tasks.progress(parent.id).blockers).toEqual([child.id]);
    expect(tasks.get(dependency.id).data.dependencies).toEqual([parent.id]);
  });

  test("повторное открытие зависимости транзитивно снимает выполнение без переноса колонок", () => {
    let leaf = task("Результат", { column: "done" });
    const middle = task("Промежуточная", { column: "done", dependencies: [leaf.key] });
    const root = task("Итог", { column: "done", dependencies: [middle.id] });
    expect(tasks.progress(root.id)).toEqual({ completed: true, canComplete: true, blockers: [] });
    leaf = tasks.move(leaf.id, { column: "review" }, options(leaf));
    expect(tasks.progress(root.id)).toEqual({
      completed: false,
      canComplete: false,
      blockers: [middle.id],
    });
    expect(tasks.progress(middle.id).blockers).toEqual([leaf.id]);
    expect(tasks.get(root.id)).toMatchObject({ revision: root.revision, data: { column: "done" } });
    leaf = tasks.move(leaf.id, { column: "cancelled" }, options(leaf));
    expect(tasks.progress(leaf.id)).toEqual({ completed: false, canComplete: true, blockers: [] });
    expect(tasks.progress(root.id).completed).toBe(false);
    tasks.move(leaf.id, { column: "done" }, options(leaf));
    expect(tasks.progress(root.id).completed).toBe(true);
  });

  test("ребёнок обязателен без отдельной зависимости; done-родитель требует завершённого нового ребёнка", () => {
    let parent = task("Родитель", { column: "done" });
    const generation = db.getGeneration();
    errorCode(() => task("Новая работа", { parent: parent.id }), "TASK_DONE");
    expect(db.getGeneration()).toBe(generation);
    let child = task("Готовый ребёнок", { parent: parent.id, column: "done" });
    expect(tasks.progress(parent.id).completed).toBe(true);
    child = tasks.move(child.id, { column: "in-progress" }, options(child));
    expect(tasks.progress(parent.id).blockers).toEqual([child.id]);
    expect(tasks.children(parent.key).map((item) => item.id)).toEqual([child.id]);
    const another = task("Другой ребёнок");
    errorCode(() => tasks.setParent(another.id, parent.id, options(another)), "TASK_DONE");
    parent = tasks.move(parent.id, { column: "in-progress" }, options(parent));
    tasks.setParent(another.id, parent.id, options(another));
    expect(tasks.progress(parent.id).blockers).toHaveLength(2);
    tasks.setParent(child.id, null, options(child));
    expect(tasks.progress(parent.id).blockers).toEqual([another.id]);
  });

  test("критерии: отметка, неизменный текст, сброс при изменении, reopen и запрет операций в done", () => {
    let record = task("Приёмка", {
      acceptanceCriteria: [
        { title: "Результат", summary: "Кратко", description: "## Проверка\nПолное условие" },
      ],
    });
    const id = tasks.criteria(record.id)[0]!.id;
    expect(tasks.getCriterion(record.id, id).completed).toBe(false);
    errorCode(() => tasks.move(record.id, { column: "done" }, options(record)), "TASK_INCOMPLETE");
    record = tasks.move(record.id, { column: "review" }, options(record));
    record = tasks.criterion(record.id, "complete", { criterionId: id }, options(record));
    const completed = tasks.getCriterion(record.id, id);
    expect(completed).toMatchObject({ completed: true, completedBy: "исполнитель" });
    expect(completed.completedAt).not.toBeNull();
    const sameText = tasks.criterion(
      record.id,
      "update",
      { id, description: completed.description },
      options(record),
    );
    expect(sameText.revision).toBe(record.revision);
    expect(tasks.getCriterion(record.id, id)).toEqual(completed);
    record = tasks.criterion(
      record.id,
      "update",
      { id, summary: "Другое условие" },
      options(record),
    );
    expect(tasks.getCriterion(record.id, id)).toMatchObject({
      completed: false,
      completedAt: null,
      completedBy: null,
    });
    record = tasks.criterion(record.id, "complete", { id }, options(record));
    record = tasks.criterion(record.id, "reopen", { id }, options(record));
    expect(tasks.progress(record.id).canComplete).toBe(false);
    record = tasks.criterion(record.id, "complete", { id }, options(record));
    expect(tasks.progress(record.id)).toEqual({
      completed: false,
      canComplete: true,
      blockers: [],
    });
    record = tasks.move(record.id, { column: "done" }, options(record));
    for (const action of ["update", "complete", "reopen", "remove"] as const) {
      errorCode(
        () =>
          tasks.criterion(
            record.id,
            action,
            action === "update" ? { id, title: "Иное" } : { id },
            options(record),
          ),
        "TASK_DONE",
      );
    }
    errorCode(
      () => tasks.criterion(record.id, "add", { title: "Новое" }, options(record)),
      "TASK_DONE",
    );
    record = tasks.move(record.id, { column: "ready" }, options(record));
    record = tasks.criterion(record.id, "remove", { id }, options(record));
    record = tasks.criterion(record.id, "add", { title: "Следующий" }, options(record));
    expect(tasks.criteria(record.id)[0]!.id).not.toBe(id);
    expect(tasks.get(record.id).revision).toBe(record.revision);
  });

  test("readiness учитывает колонку и обязательства, а completion — сохранённые done/cancelled", () => {
    const dependency = task("Зависимость");
    const ready = task("Можно начать", {
      column: "ready",
      acceptanceCriteria: [{ title: "Ещё не проверено" }],
      description: "Уникальный Markdown",
    });
    const blocked = task("Заблокировано", { column: "ready", dependencies: [dependency.id] });
    const cancelled = task("Отменено", { column: "cancelled" });
    const completed = task("Завершено", { column: "done" });
    expect(tasks.list({ readiness: "ready" }).map((item) => item.id)).toEqual([ready.id]);
    expect(tasks.list({ readiness: "blocked" }).map((item) => item.id)).toEqual([blocked.id]);
    expect(tasks.list({ completion: "finished" }).map((item) => item.id)).toEqual([
      cancelled.id,
      completed.id,
    ]);
    expect(tasks.list({ completion: "unfinished" })).toHaveLength(3);
    expect(tasks.list({ q: "markdown", searchIn: "title" })).toEqual([]);
    expect(
      tasks.list({ q: "markdown", searchIn: "all", board: "PRODUCT" }).map((item) => item.id),
    ).toEqual([ready.id]);
    expect(tasks.list({ parent: null })).toHaveLength(5);
    expect(TASK_COLUMNS).toHaveLength(6);
  });

  test("цели ограничены доской и активным собственным участием; снятая цель сохраняется в прежней задаче", () => {
    const feature = entities.create("feature", "FEAT", { name: "Возможность" }, "автор");
    const { application, board } = applicationBoard();
    const foreign = applicationBoard("api");
    let implementation = entities.create(
      "implementation",
      "IMPL",
      { applicationId: application.id, targetId: feature.id, active: true },
      "автор",
    );
    const foreignImplementation = entities.create(
      "implementation",
      "IMPL",
      { applicationId: foreign.application.id, targetId: feature.id, active: true },
      "автор",
    );
    let productTask = task("Общая работа", { targets: [feature.key] });
    const appTask = task("Реализация", { board: board.id, targets: [implementation.key] });
    expect(appTask.data.targets).toEqual([implementation.id]);
    errorCode(() => task("Неверная цель", { targets: [implementation.id] }), "INVALID_ARGUMENT");
    errorCode(
      () => task("Неверная цель", { board: board.id, targets: [feature.id] }),
      "INVALID_ARGUMENT",
    );
    errorCode(
      () => task("Чужая цель", { board: board.id, targets: [foreignImplementation.id] }),
      "INVALID_ARGUMENT",
    );
    errorCode(() => task("Дубликат", { targets: [feature.id, feature.key] }), "INVALID_ARGUMENT");
    const generation = db.getGeneration();
    errorCode(
      () => tasks.move(productTask.id, { board: board.id }, options(productTask)),
      "INVALID_ARGUMENT",
    );
    expect(tasks.get(productTask.id)).toEqual(productTask);
    expect(db.getGeneration()).toBe(generation);
    productTask = tasks.update(productTask.id, { targets: [] }, options(productTask));
    productTask = tasks.move(productTask.id, { board: board.id }, options(productTask));
    expect(productTask.data.targets).toEqual([]);
    implementation = entities.update(
      implementation.id,
      "implementation",
      { active: false },
      options(implementation),
    );
    errorCode(
      () => task("Снятая цель", { board: board.id, targets: [implementation.id] }),
      "INVALID_ARGUMENT",
    );
    expect(
      tasks.update(appTask.id, { targets: [implementation.id] }, options(appTask)).revision,
    ).toBe(appTask.revision);
    expect(tasks.move(appTask.id, { column: "review" }, options(appTask)).data.targets).toEqual([
      implementation.id,
    ]);
  });

  test("productTarget раскрывает сценарии и активные реализации, target выбирает только прямую цель", () => {
    const feature = entities.create("feature", "FEAT", {}, "автор");
    const scenario = entities.create("scenario", "SCEN", { featureId: feature.id }, "автор");
    const { application, board } = applicationBoard();
    const implementation = entities.create(
      "implementation",
      "IMPL",
      { applicationId: application.id, targetId: scenario.id, active: true },
      "автор",
    );
    const featureImplementation = entities.create(
      "implementation",
      "IMPL",
      { applicationId: application.id, targetId: feature.id, active: true },
      "автор",
    );
    const direct = task("Продукт", { targets: [feature.id] });
    const scenarioTask = task("Сценарий", { targets: [scenario.id] });
    const implementationTask = task("Приложение", {
      board: board.id,
      targets: [implementation.id],
    });
    const featureImplementationTask = task("Фича приложения", {
      board: board.id,
      targets: [featureImplementation.id],
    });
    expect(tasks.list({ target: feature.id }).map((item) => item.id)).toEqual([direct.id]);
    expect(new Set(tasks.list({ productTarget: feature.key }).map((item) => item.id))).toEqual(
      new Set([direct.id, scenarioTask.id, implementationTask.id, featureImplementationTask.id]),
    );
    expect(
      new Set(tasks.list({ productTarget: featureImplementation.id }).map((item) => item.id)),
    ).toEqual(new Set([featureImplementationTask.id, implementationTask.id]));
    entities.update(
      implementation.id,
      "implementation",
      { active: false },
      options(implementation),
    );
    expect(tasks.list({ productTarget: scenario.id }).map((item) => item.id)).toEqual([
      scenarioTask.id,
    ]);
  });

  test("перенос сохраняет ID, связи, алиасы и ровно одну новую ревизию", () => {
    const { board } = applicationBoard();
    let record = task("Переносимая");
    const oldKey = record.key;
    const dependant = task("Потребитель", { dependencies: [record.key] });
    record = tasks.move(oldKey, { board: board.data.slug, column: "review" }, options(record));
    expect(record).toMatchObject({
      key: "WEB-1",
      revision: 2,
      data: { boardId: board.id, column: "review" },
    });
    expect(tasks.get(oldKey)).toEqual(record);
    expect(tasks.dependencies(dependant.id)[0]!.id).toBe(record.id);
    const movedKey = record.key;
    record = tasks.move(record.id, { board: "product" }, options(record));
    expect(record.key).toBe("PRODUCT-3");
    expect(record.revision).toBe(3);
    expect(tasks.get(movedKey).id).toBe(record.id);
    expect(tasks.get(oldKey).key).toBe(record.key);
    const fresh = task("Новая", { board: board.id });
    expect(fresh.key).toBe("WEB-2");
  });

  test("устаревшая ревизия отклоняется даже для no-op и не обновляется автоматически", () => {
    const original = task("Исходная");
    const peer = ProjectDatabase.open(db.path);
    connections.push(peer);
    const concurrent = new TasksService(peer).update(
      original.id,
      { title: "Другой автор" },
      options(original),
    );
    const generation = db.getGeneration();
    errorCode(
      () => tasks.update(original.id, { title: concurrent.data.title }, options(original)),
      "REVISION_CONFLICT",
    );
    errorCode(() => tasks.setParent(original.id, null, options(original)), "REVISION_CONFLICT");
    errorCode(
      () => tasks.move(original.id, { column: "inbox" }, options(original)),
      "REVISION_CONFLICT",
    );
    expect(tasks.get(original.id)).toEqual(concurrent);
    expect(db.getGeneration()).toBe(generation);
  });

  test("внешний rollback отменяет содержание, критерии, ключи и ревизии вложенных операций", () => {
    const original = task("Исходная");
    const { board } = applicationBoard();
    const generation = db.getGeneration();
    expect(() =>
      db.transaction(() => {
        let changed = tasks.update(original.id, { title: "Временная" }, options(original));
        changed = tasks.criterion(changed.id, "add", { title: "Критерий" }, options(changed));
        tasks.move(changed.id, { board: board.id }, options(changed));
        throw new Error("Отмена пакета");
      }),
    ).toThrow("Отмена пакета");
    expect(tasks.get(original.id)).toEqual(original);
    expect(db.get("WEB-1", "task")).toBeUndefined();
    expect(db.getGeneration()).toBe(generation);
    expect(tasks.move(original.id, { board: board.id }, options(original)).key).toBe("WEB-1");
  });

  test("публикация комментариев append-only переживает запись со старой ревизией содержания и повторное открытие БД", () => {
    let record = task("Обсуждение", { column: "done" });
    const initial = record;
    const generation = db.getGeneration();
    record = tasks.comment(record.key, "## Причина\nПодробное объяснение", "рецензент", "Проверка");
    expect(record.revision).toBe(initial.revision);
    expect(record.updatedAt).toBe(initial.updatedAt);
    expect(record.updatedBy).toBe(initial.updatedBy);
    expect(db.getGeneration()).toBeGreaterThan(generation);
    expect(tasks.progress(record.id).completed).toBe(true);
    const first = tasks.comments(record.id)[0]!;
    expect(first).toMatchObject({
      title: "Проверка",
      body: "## Причина\nПодробное объяснение",
      createdBy: "рецензент",
    });
    const peer = ProjectDatabase.open(db.path);
    connections.push(peer);
    new TasksService(peer).comment(record.id, "Второе сообщение", "другой автор");
    record = tasks.update(record.id, { title: "Уточнение" }, options(initial));
    expect(record.revision).toBe(initial.revision + 1);
    expect(tasks.comments(record.id)).toHaveLength(2);
    expect(tasks.getComment(record.id, first.id)).toEqual(first);
    errorCode(() => tasks.update(record.id, { comments: [] }, options(record)), "INVALID_ARGUMENT");
    errorCode(() => tasks.comment(record.id, "  ", "автор"), "INVALID_ARGUMENT");
    db.close();
    const reopened = ProjectDatabase.open(peer.path);
    connections.push(reopened);
    expect(new TasksService(reopened).comments(record.id)).toHaveLength(2);
    expect(new TasksService(reopened).get(record.id).revision).toBe(record.revision);
  });

  test("завершение видит конкурентное открытие зависимости после ожидания блокировки SQLite", async () => {
    const dependency = task("Готовое обязательство", { column: "done" });
    const record = task("Закрываемая задача", { column: "review", dependencies: [dependency.id] });
    const signal = join(directory, "ready");
    const result = join(directory, "result.json");
    const script = join(directory, "complete.ts");
    const source = pathToFileURL(resolve(import.meta.dir, "../../src/tasks.ts")).href;
    const storageSource = pathToFileURL(
      resolve(import.meta.dir, "../../../storage/src/index.ts"),
    ).href;
    writeFileSync(
      script,
      `
      import { writeFileSync } from 'node:fs';
      import { ProjectDatabase } from ${JSON.stringify(storageSource)};
      import { TasksService } from ${JSON.stringify(source)};
      const db = ProjectDatabase.open(${JSON.stringify(db.path)});
      writeFileSync(${JSON.stringify(signal)}, 'ready');
      try {
        new TasksService(db).move(${JSON.stringify(record.id)}, {column:'done'}, {actor:'конкурент',ifRevision:${record.revision}});
        writeFileSync(${JSON.stringify(result)}, JSON.stringify({code:'UNEXPECTED_SUCCESS'}));
      } catch (error) {
        writeFileSync(${JSON.stringify(result)}, JSON.stringify({code:error.code,message:error.message}));
      } finally { db.close(); }
    `,
    );
    let worker: ReturnType<typeof Bun.spawn> | undefined;
    db.transaction(() => {
      worker = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
      processes.push(worker);
      const deadline = Date.now() + 3000;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(signal) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
      expect(existsSync(signal)).toBe(true);
      tasks.move(dependency.id, { column: "in-progress" }, options(dependency));
    });
    expect(await worker!.exited).toBe(0);
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ code: "TASK_INCOMPLETE" });
    expect(tasks.get(record.id)).toEqual(record);
    expect(tasks.progress(record.id).canComplete).toBe(false);
  });

  test("строгий ввод не пропускает неизвестные поля, неверные типы, дубликаты и несуществующие ссылки", () => {
    const record = task("Исходная");
    const generation = db.getGeneration();
    for (const input of [
      { title: null },
      { title: "Две\nстроки" },
      { title: undefined },
      { column: "blocked" },
      { dependencies: "PRODUCT-1" },
      { progress: 100 },
      { acceptanceCriteria: [{ title: "" }] },
      { acceptanceCriteria: Array.from({ length: 101 }, () => ({ title: "Критерий" })) },
    ]) {
      errorCode(() => tasks.create(input, "автор"), "INVALID_ARGUMENT");
    }
    errorCode(
      () => tasks.create({ dependencies: [record.id, record.key] }, "автор"),
      "INVALID_ARGUMENT",
    );
    errorCode(
      () => tasks.dependency(record.id, "PRODUCT-999", false, options(record)),
      "NOT_FOUND",
    );
    errorCode(() => tasks.create({ targets: ["FEAT-404"] }, "автор"), "NOT_FOUND");
    errorCode(
      () => tasks.move(record.id, { column: "done", before: record.id }, options(record)),
      "INVALID_ARGUMENT",
    );
    errorCode(() => tasks.list({ readiness: "almost" }), "INVALID_ARGUMENT");
    errorCode(() => tasks.list({ searchIn: "comments" }), "INVALID_ARGUMENT");
    errorCode(() => tasks.list({ unexpected: true }), "INVALID_ARGUMENT");
    expect(tasks.get(record.id)).toEqual(record);
    expect(db.getGeneration()).toBe(generation);
  });

  test("повреждённая обязательная ссылка диагностируется вместо ложной готовности", () => {
    const record = task("Повреждение");
    entities.update(record.id, "task", { dependencies: ["missing-task"] }, options(record));
    errorCode(() => tasks.progress(record.id), "BROKEN_REFERENCE");
    errorCode(() => tasks.list({ readiness: "ready" }), "BROKEN_REFERENCE");
  });
});
