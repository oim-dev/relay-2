import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { TasksService } from "../../src/tasks";

test("завершение задачи удерживает блокировку от чтения графа до записи, после commit второй писатель продолжает работу", () => {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "task-transaction-"));
  const connections: ProjectDatabase[] = [];
  try {
    const db = ProjectDatabase.create(join(directory, "project.sqlite"), {
      id: crypto.randomUUID(),
      name: "Атомарное завершение",
      slug: "task-transaction",
    });
    connections.push(db);
    const competitor = ProjectDatabase.open(db.path);
    connections.push(competitor);
    const tasks = new TasksService(db);
    const competingTasks = new TasksService(competitor);
    const dependency = tasks.create({ title: "Обязательство", column: "done" }, "author");
    const task = tasks.create(
      { title: "Завершаемая задача", column: "review", dependencies: [dependency.id] },
      "author",
    );
    const generation = db.getGeneration();
    const readGraph = db.listTaskGraph.bind(db);
    let attempted = false;
    let rejected: unknown;

    // Настоящий граф уже прочитан, но задача ещё не записана. Второе SQLite-соединение
    // пытается открыть обязательство именно в этом промежутке; расписание не зависит
    // от скорости процесса. Spy служит барьером, а не подменяет чтение или блокировку.
    const interception = spyOn(db, "listTaskGraph").mockImplementation(() => {
      const graph = readGraph();
      if (!attempted) {
        attempted = true;
        try {
          competingTasks.move(
            dependency.id,
            { column: "ready" },
            { actor: "competitor", ifRevision: dependency.revision },
          );
        } catch (error) {
          rejected = error;
        }
      }
      return graph;
    });
    try {
      const completed = tasks.move(
        task.id,
        { column: "done" },
        { actor: "author", ifRevision: task.revision },
      );
      expect(attempted).toBe(true);
      expect(rejected).toBeInstanceOf(RelayError);
      expect(rejected).toMatchObject({ code: "STORAGE_BUSY", exitCode: 4 });
      expect(tasks.get(dependency.id)).toEqual(dependency);
      expect(completed).toMatchObject({
        id: task.id,
        revision: task.revision + 1,
        data: { column: "done" },
      });
      expect(competingTasks.get(task.id)).toEqual(completed);
      expect(db.getGeneration()).toBe(generation + 1);
    } finally {
      interception.mockRestore();
    }

    // Повторяем явно с исходной ревизией: отказ не изменил зависимость, а commit
    // первой операции освободил writer-lock. Автоматического обновления ревизии нет.
    const reopened = competingTasks.move(
      dependency.id,
      { column: "ready" },
      { actor: "competitor", ifRevision: dependency.revision },
    );
    expect(reopened).toMatchObject({
      id: dependency.id,
      revision: dependency.revision + 1,
      data: { column: "ready" },
    });
    expect(tasks.get(dependency.id)).toEqual(reopened);
    expect(db.getGeneration()).toBe(generation + 2);
  } finally {
    for (const connection of connections.reverse()) connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
