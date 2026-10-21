import { describe, expect, test } from "bun:test";
import { TasksService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { arrayValue, entityValue, objectValue, stringValue } from "./helpers/responses";

describe("CLI: задачи", () => {
  test("create разбирает JSON критериев и criterion list возвращает вложенные записи", async () => {
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

  test("criterion complete и move в done отражаются в вычисляемом прогрессе задачи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { task, criterion } = cli.withDatabase(project, (db) => {
        const tasks = new TasksService(db);
        const task = tasks.create(
          { title: "Работа", acceptanceCriteria: [{ title: "Проверено" }] },
          "fixture",
        );
        return { task, criterion: tasks.criteria(task.id)[0]! };
      });
      expect(objectValue((await cli.success(["task", "progress", task.key])).data)).toEqual({
        completed: false,
        canComplete: false,
        blockers: [],
      });
      const checked = await cli.entity([
        "task",
        "criterion",
        "complete",
        task.key,
        criterion.id,
        "--if-revision",
        String(task.revision),
      ]);

      expect(checked.revision).toBe(task.revision + 1);
      expect(arrayValue(checked.data.acceptanceCriteria)).toEqual([
        { ...criterion, completed: true, completedAt: expect.any(String), completedBy: "agent" },
      ]);
      expect(objectValue((await cli.success(["task", "progress", task.key])).data)).toEqual({
        completed: false,
        canComplete: true,
        blockers: [],
      });
      const completed = await cli.entity([
        "task",
        "move",
        task.key,
        "--column",
        "done",
        "--if-revision",
        String(checked.revision),
      ]);
      expect(completed.revision).toBe(checked.revision + 1);
      expect(completed.data.column).toBe("done");
      expect(objectValue((await cli.success(["task", "progress", task.key])).data)).toEqual({
        completed: true,
        canComplete: true,
        blockers: [],
      });
    });
  });

  test("parent set и clear меняют родителя и список прямых детей", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { parent, child } = cli.withDatabase(project, (db) => {
        const tasks = new TasksService(db);
        return {
          parent: tasks.create({ title: "Родитель" }, "fixture"),
          child: tasks.create({ title: "Ребёнок" }, "fixture"),
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
      const cleared = await cli.entity([
        "task",
        "parent",
        "clear",
        child.key,
        "--if-revision",
        String(assigned.revision),
      ]);
      expect(cleared.data.parentId).toBeNull();
      expect(cleared.revision).toBe(assigned.revision + 1);
      expect((await cli.page(["task", "children", parent.key], entityValue)).data.items).toEqual(
        [],
      );
    });
  });

  test("dependency add разрешает ключ зависимости и показывает её как блокер прогресса", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { task, dependency } = cli.withDatabase(project, (db) => {
        const tasks = new TasksService(db);
        return {
          task: tasks.create({ title: "Работа" }, "fixture"),
          dependency: tasks.create({ title: "Предварительная работа" }, "fixture"),
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

  test("dependency list и update возвращают CORRUPT_DATA для повреждённых зависимостей без изменений", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { damaged, generation } = cli.withDatabase(project, (db) => {
        const task = new TasksService(db).create({ title: "Повреждение" }, "fixture");
        // Намеренное повреждение через Storage, не допустимый ввод предметного API.
        db.update(
          { ...task, revision: task.revision + 1, data: { ...task.data, dependencies: null } },
          task.revision,
        );
        return { damaged: db.get(task.id)!, generation: db.getGeneration() };
      });

      expect(await cli.error(["task", "dependency", "list", damaged.key], 1)).toMatchObject({
        code: "CORRUPT_DATA",
      });
      expect(
        await cli.error(
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
        ),
      ).toMatchObject({ code: "CORRUPT_DATA" });
      cli.withDatabase(project, (db) => {
        expect(db.get(damaged.id)).toEqual(damaged);
        expect(db.getGeneration()).toBe(generation);
      });
    });
  });

  test("comment add/get/list сохраняют полный текст без изменения ревизии задачи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const task = cli.withDatabase(project, (db) =>
        new TasksService(db).create({ title: "Обсуждение" }, "fixture"),
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

  test("comment add отклоняет неизвестное поле JSON без публикации комментария", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const task = cli.withDatabase(project, (db) =>
        new TasksService(db).create({ title: "Обсуждение" }, "fixture"),
      );

      expect(
        await cli.error(
          [
            "task",
            "comment",
            "add",
            task.key,
            "--input",
            JSON.stringify({ body: "Не сохранять", unknown: true }),
          ],
          2,
        ),
      ).toMatchObject({ code: "INVALID_ARGUMENT" });
      const comments = await cli.page(["task", "comment", "list", task.key], objectValue);
      expect(comments.data.items).toEqual([]);
      expect(comments.meta.page.total).toBe(0);
      expect(await cli.entity(["task", "get", task.key])).toEqual(task);
    });
  });
});
