import { describe, expect, test } from "bun:test";
import { TasksService } from "@relay/core";
import type { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import { arrayValue, entityValue, objectValue, stringValue } from "./helpers/responses";
import type { CorruptedTaskFixture, TaskWithCriterion } from "./helpers/task-fixture.types";

/**
 * Создаёт задачу с одним критерием через Core; соединение принадлежит вызывающей fixture.
 */
async function createTaskWithCriterion(db: ProjectDatabase): Promise<TaskWithCriterion> {
  const tasks = new TasksService(db);
  const task = await tasks.create(
    { title: "Работа", acceptanceCriteria: [{ title: "Проверено" }] },
    "fixture",
  );
  const [criterion] = tasks.criteria(task.id);
  if (!criterion) {
    throw new Error("Подготовленная задача должна содержать критерий");
  }
  return { task, criterion };
}

/**
 * Намеренно записывает null вместо dependencies через Storage для проверки отказа декодера.
 * Возвращает состояние после повреждения; соединение не закрывает и не скрывает записи.
 */
async function createCorruptedDependencies(db: ProjectDatabase): Promise<CorruptedTaskFixture> {
  const task = await new TasksService(db).create({ title: "Повреждение" }, "fixture");
  db.update(
    { ...task, revision: task.revision + 1, data: { ...task.data, dependencies: null } },
    task.revision,
  );
  return { damaged: entityValue(db.get(task.id)), generation: db.getGeneration() };
}

describe("Задачи через CLI", () => {
  test("JSON критериев создания сохраняется в списке вложенных записей задачи", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();

      const task = await cli.entity([
        "task",
        "create",
        "--title",
        "Работа",
        "--acceptance-criteria",
        JSON.stringify([{ title: "Проверено", description: "# Проверка\n\n  результат" }]),
      ]);
      const criteria = await cli.page(["task", "criterion", "list", task.key], objectValue);

      expect(criteria.meta.page.total).toBe(1);
      expect(criteria.data).toMatchObject({ ref: task.key, revision: task.revision });
      expect(criteria.data.items).toEqual(
        arrayValue(task.data.acceptanceCriteria).map(objectValue),
      );
      expect(criteria.data.items[0]).toMatchObject({
        id: expect.any(String),
        title: "Проверено",
        description: "# Проверка\n\n  результат",
        completed: false,
        completedAt: null,
        completedBy: null,
      });
    });
  });

  test("выполнение критерия делает задачу готовой к завершению без перевода в done", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { task, criterion } = await cli.withDatabase(project, createTaskWithCriterion);
      const initialProgress = objectValue((await cli.success(["task", "progress", task.key])).data);

      const checked = await cli.entity([
        "task",
        "criterion",
        "complete",
        task.key,
        criterion.id,
        "--if-revision",
        String(task.revision),
      ]);

      expect(initialProgress).toEqual({
        completed: false,
        canComplete: false,
        blockers: [],
      });
      expect(checked.revision).toBe(task.revision + 1);
      expect(arrayValue(checked.data.acceptanceCriteria)).toEqual([
        { ...criterion, completed: true, completedAt: expect.any(String), completedBy: "agent" },
      ]);
      expect(objectValue((await cli.success(["task", "progress", task.key])).data)).toEqual({
        completed: false,
        canComplete: true,
        blockers: [],
      });
    });
  });

  test("перевод готовой задачи в done сохраняет колонку и вычисляемое завершение", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const checked = await cli.withDatabase(project, async (db) => {
        const { task, criterion } = await createTaskWithCriterion(db);
        return await new TasksService(db).criterion(
          task.id,
          "complete",
          { id: criterion.id },
          {
            actor: "fixture",
            ifRevision: task.revision,
          },
        );
      });

      const completed = await cli.entity([
        "task",
        "move",
        checked.key,
        "--column",
        "done",
        "--if-revision",
        String(checked.revision),
      ]);

      expect(completed.revision).toBe(checked.revision + 1);
      expect(completed.data.column).toBe("done");
      expect(objectValue((await cli.success(["task", "progress", checked.key])).data)).toEqual({
        completed: true,
        canComplete: true,
        blockers: [],
      });
    });
  });

  test("назначение родителя сохраняет его ID и добавляет задачу в прямых детей", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { parent, child } = await cli.withDatabase(project, async (db) => {
        const tasks = new TasksService(db);
        return {
          parent: await tasks.create({ title: "Родитель" }, "fixture"),
          child: await tasks.create({ title: "Ребёнок" }, "fixture"),
        };
      });

      const assigned = await cli.entity([
        "task",
        "parent",
        "set",
        child.key,
        parent.key,
        "--if-revision",
        String(child.revision),
      ]);
      const children = await cli.page(["task", "children", parent.key], entityValue);

      expect(assigned.data.parentId).toBe(parent.id);
      expect(assigned.revision).toBe(child.revision + 1);
      expect(children.meta.page.total).toBe(1);
      expect(children.data.items.map((item) => item.id)).toEqual([child.id]);
    });
  });

  test("снятие родителя очищает связь и исключает задачу из прямых детей", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { parent, child } = await cli.withDatabase(project, async (db) => {
        const tasks = new TasksService(db);
        const parent = await tasks.create({ title: "Родитель" }, "fixture");
        const child = await tasks.create({ title: "Ребёнок" }, "fixture");
        const assigned = await tasks.setParent(child.id, parent.id, {
          actor: "fixture",
          ifRevision: child.revision,
        });
        return { parent, child: assigned };
      });

      const cleared = await cli.entity([
        "task",
        "parent",
        "clear",
        child.key,
        "--if-revision",
        String(child.revision),
      ]);

      expect(cleared.data.parentId).toBeNull();
      expect(cleared.revision).toBe(child.revision + 1);
      expect((await cli.page(["task", "children", parent.key], entityValue)).data.items).toEqual(
        [],
      );
    });
  });

  test("добавление зависимости по ключу сохраняет её ID и показывает блокер прогресса", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { task, dependency } = await cli.withDatabase(project, async (db) => {
        const tasks = new TasksService(db);
        return {
          task: await tasks.create({ title: "Работа" }, "fixture"),
          dependency: await tasks.create({ title: "Предварительная работа" }, "fixture"),
        };
      });

      const linked = await cli.entity([
        "task",
        "dependency",
        "add",
        task.key,
        dependency.key,
        "--if-revision",
        String(task.revision),
      ]);
      const dependencies = await cli.page(["task", "dependency", "list", task.key], entityValue);

      expect(linked.revision).toBe(task.revision + 1);
      expect(linked.data.dependencies).toEqual([dependency.id]);
      expect(dependencies.data).toMatchObject({ ref: task.key, revision: linked.revision });
      expect(dependencies.data.items).toEqual([dependency]);
      expect(dependencies.meta.page.total).toBe(1);
      expect(objectValue((await cli.success(["task", "progress", task.key])).data)).toEqual({
        completed: false,
        canComplete: false,
        blockers: [dependency.id],
      });
    });
  });

  test("чтение повреждённых зависимостей возвращает CORRUPT_DATA без изменения записи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { damaged, generation } = await cli.withDatabase(project, createCorruptedDependencies);

      const error = await cli.error(["task", "dependency", "list", damaged.key], 1);

      expect(error.code).toBe("CORRUPT_DATA");
      cli.withDatabase(project, (db) => {
        expect(db.get(damaged.id)).toEqual(damaged);
        expect(db.getGeneration()).toBe(generation);
      });
    });
  });

  test("обновление задачи с повреждёнными зависимостями возвращает CORRUPT_DATA без записи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { damaged, generation } = await cli.withDatabase(project, createCorruptedDependencies);

      const error = await cli.error(
        [
          "task",
          "update",
          damaged.key,
          "--title",
          "Не сохранять",
          "--if-revision",
          String(damaged.revision),
        ],
        1,
      );

      expect(error.code).toBe("CORRUPT_DATA");
      cli.withDatabase(project, (db) => {
        expect(db.get(damaged.id)).toEqual(damaged);
        expect(db.getGeneration()).toBe(generation);
      });
    });
  });

  test("добавленный комментарий читается целиком без изменения ревизии задачи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const task = await cli.withDatabase(
        project,
        async (db) => await new TasksService(db).create({ title: "Обсуждение" }, "fixture"),
      );
      const body = "# Полный текст комментария\n\n    точный отступ\n";

      const commented = await cli.entity([
        "task",
        "comment",
        "add",
        task.key,
        "--title",
        "Наблюдение",
        "--body",
        body,
      ]);
      const comments = await cli.page(["task", "comment", "list", task.key], objectValue);

      expect(commented.revision).toBe(task.revision);
      expect(comments.meta.page.total).toBe(1);
      expect(comments.data).toMatchObject({ task: task.key, revision: task.revision });
      const comment = objectValue(comments.data.items[0]);
      const commentId = stringValue(comment.id);
      expect(comment).toEqual({
        id: commentId,
        title: "Наблюдение",
        body,
        createdBy: "agent",
        createdAt: stringValue(comment.createdAt),
      });
      expect(
        objectValue((await cli.success(["task", "comment", "get", task.key, commentId])).data),
      ).toEqual(comment);
      expect((await cli.entity(["task", "get", task.key])).revision).toBe(task.revision);
    });
  });

  test("неизвестное поле JSON комментария отклоняется без его публикации", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const task = await cli.withDatabase(
        project,
        async (db) => await new TasksService(db).create({ title: "Обсуждение" }, "fixture"),
      );

      const error = await cli.error(
        [
          "task",
          "comment",
          "add",
          task.key,
          "--input",
          JSON.stringify({ body: "Не сохранять", unknown: true }),
        ],
        2,
      );

      expect(error.code).toBe("INVALID_ARGUMENT");
      const comments = await cli.page(["task", "comment", "list", task.key], objectValue);
      expect(comments.data.items).toEqual([]);
      expect(comments.meta.page.total).toBe(0);
      expect(await cli.entity(["task", "get", task.key])).toEqual(task);
    });
  });
});
