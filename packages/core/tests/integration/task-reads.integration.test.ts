import { describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import type { TaskComment, TaskCriterion, TaskRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import type { TaskCollection } from "../../src/tasks/task-read.types";
import { TasksService } from "../../src/tasks/tasks";
import {
  entityWriteOptions,
  expectAsyncRelayError,
  expectRelayError,
  withEntityDatabase,
} from "./helpers/entity-fixture";

const ownerReads = [
  {
    name: "dependenciesWithOwner",
    /**
     * Читает прямые зависимости вместе с владельцем.
     */
    read: (tasks: TasksService, ref: string): unknown => tasks.dependenciesWithOwner(ref),
  },
  {
    name: "criteriaWithOwner",
    /**
     * Читает критерии вместе с владельцем.
     */
    read: (tasks: TasksService, ref: string): unknown => tasks.criteriaWithOwner(ref),
  },
  {
    name: "getCriterionWithOwner",
    /**
     * Запрашивает отсутствующий критерий, чтобы проверить приоритет ошибки владельца.
     */
    read: (tasks: TasksService, ref: string): unknown =>
      tasks.getCriterionWithOwner(ref, "missing-criterion"),
  },
  {
    name: "commentsWithOwner",
    /**
     * Читает независимый журнал вместе с владельцем.
     */
    read: (tasks: TasksService, ref: string): unknown => tasks.commentsWithOwner(ref),
  },
] as const;

/**
 * Создаёт два критерия и два независимых комментария с полными текстами.
 * Соединением владеет вызывающий тест; helper возвращает состояние после публикаций.
 */
async function createNestedTask(tasks: TasksService): Promise<TaskRecord> {
  const task = await tasks.create(
    {
      title: "Приёмка и обсуждение",
      acceptanceCriteria: [
        { title: "Первый", summary: "Условие", description: "## Проверка\n\n  результат\n" },
        { title: "Второй" },
      ],
    },
    "автор",
  );
  await tasks.comment(task.id, "## Первый\n\n  точный отступ\n", "рецензент");
  return tasks.comment(task.id, "Второй комментарий", "другой автор", "Ответ");
}

describe("Составные чтения владельца и вложенных данных задачи", () => {
  test.each([
    { method: "criteriaWithOwner", field: "acceptanceCriteria" },
    { method: "commentsWithOwner", field: "comments" },
  ] as const)(
    "$method читает владельца один раз и сохраняет полный состав",
    async ({ method, field }) => {
      await withEntityDatabase(async (db) => {
        const tasks = new TasksService(db);
        const owner = await createNestedTask(tasks);
        const generation = db.getGeneration();
        const fullRead = spyOn(db, "get");
        const identityRead = spyOn(db, "getIdentity");
        try {
          const result: TaskCollection<TaskCriterion | TaskComment> = tasks[method](
            `task:${owner.key}`,
          );

          expect(result).toEqual({
            task: owner.key,
            revision: owner.revision,
            items: owner.data[field],
          });
          expect(fullRead).toHaveBeenCalledTimes(1);
          expect(identityRead).toHaveBeenCalledTimes(1);
        } finally {
          fullRead.mockRestore();
          identityRead.mockRestore();
        }
        expect(tasks.get(owner.id)).toEqual(owner);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("критерий возвращается с ревизией владельца после одного полного чтения", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const initial = await createNestedTask(tasks);
      const [criterion] = initial.data.acceptanceCriteria;
      assert(criterion);
      const owner = await tasks.criterion(
        initial.id,
        "complete",
        { id: criterion.id },
        entityWriteOptions(initial),
      );
      const generation = db.getGeneration();
      const fullRead = spyOn(db, "get");
      const identityRead = spyOn(db, "getIdentity");
      try {
        const result = tasks.getCriterionWithOwner(owner.key, criterion.id);

        expect(result).toEqual({
          task: owner.key,
          revision: initial.revision + 1,
          criterion: {
            ...criterion,
            completed: true,
            completedBy: "tester",
            completedAt: expect.any(String),
          },
        });
        expect(fullRead).toHaveBeenCalledTimes(1);
        expect(identityRead).toHaveBeenCalledTimes(1);
      } finally {
        fullRead.mockRestore();
        identityRead.mockRestore();
      }
      expect(tasks.get(owner.id)).toEqual(owner);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("зависимости сохраняют порядок и полные журналы с одним чтением владельца по алиасу", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const first = await tasks.create({ title: "Первая созданная" }, "автор");
      const second = await createNestedTask(tasks);
      const initial = await tasks.create({ dependencies: [second.id, first.id] }, "автор");
      const application = await new KnowledgeService(db).create(
        "application",
        { name: "Приложение", slug: "web" },
        "автор",
      );
      const owner = await tasks.move(
        initial.id,
        { board: application.data.boardId },
        entityWriteOptions(initial),
      );
      const generation = db.getGeneration();
      const fullRead = spyOn(db, "get");
      const identityRead = spyOn(db, "getIdentity");
      try {
        const result = tasks.dependenciesWithOwner(`task:${initial.key}`);

        expect(result).toEqual({
          task: owner.key,
          revision: owner.revision,
          items: [second, first],
        });
        expect(fullRead).toHaveBeenCalledTimes(3);
        expect(fullRead.mock.calls.filter(([ref]) => ref === owner.id)).toHaveLength(1);
        expect(identityRead).toHaveBeenCalledTimes(3);
        expect(identityRead.mock.calls.filter(([ref]) => ref === initial.key)).toHaveLength(1);
      } finally {
        fullRead.mockRestore();
        identityRead.mockRestore();
      }
      expect(tasks.get(owner.id)).toEqual(owner);
      expect(tasks.get(first.id)).toEqual(first);
      expect(tasks.get(second.id)).toEqual(second);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("владелец и зависимости остаются в одном снимке при коммите между их чтениями", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const dependency = await tasks.create({ title: "Исходное обязательство" }, "автор");
      const owner = await tasks.create({ dependencies: [dependency.id] }, "автор");
      const peer = ProjectDatabase.open(db.path);
      try {
        /**
         * Сохраняет настоящее чтение снимка перед синхронизированной записью второго соединения.
         */
        const read: ProjectDatabase["get"] = db.get.bind(db);
        let changed = false;
        const interception = spyOn(db, "get").mockImplementation((ref, kind) => {
          const record = read(ref, kind);
          if (ref === owner.id && !changed) {
            changed = true;
            // Синхронный SQL-коммит после чтения владельца, до зависимости:
            // тест защищает snapshot чтения, а async writers проверяются отдельно.
            peer.transaction(() => {
              peer.update(
                {
                  ...owner,
                  revision: owner.revision + 1,
                  data: { ...owner.data, title: "Новая задача" },
                },
                owner.revision,
              );
              peer.update(
                {
                  ...dependency,
                  revision: dependency.revision + 1,
                  data: { ...dependency.data, title: "Новое обязательство" },
                },
                dependency.revision,
              );
              peer.appendTaskComment(dependency.id, {
                id: crypto.randomUUID(),
                body: "Позднее сообщение",
                title: "",
                createdAt: new Date().toISOString(),
                createdBy: "рецензент",
              });
            });
          }
          return record;
        });
        try {
          const result = tasks.dependenciesWithOwner(owner.id);

          expect(changed).toBe(true);
          expect(result).toEqual({
            task: owner.key,
            revision: owner.revision,
            items: [dependency],
          });
        } finally {
          interception.mockRestore();
        }
        const next = tasks.dependenciesWithOwner(owner.id);
        expect(next.revision).toBe(owner.revision + 1);
        expect(next.items).toEqual([
          expect.objectContaining({
            id: dependency.id,
            revision: dependency.revision + 1,
            data: {
              ...dependency.data,
              title: "Новое обязательство",
              comments: [expect.objectContaining({ body: "Позднее сообщение" })],
            },
          }),
        ]);
      } finally {
        peer.close();
      }
    });
  });

  test("ревизия составного чтения допускает запись после append, сохраняя журнал и CAS", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const owner = await createNestedTask(tasks);
      const before = tasks.commentsWithOwner(owner.id);
      const appended = await tasks.comment(owner.id, "После чтения", "рецензент");

      const updated = await tasks.update(
        owner.id,
        { title: "Уточнение" },
        { actor: "редактор", ifRevision: before.revision },
      );
      const after = tasks.commentsWithOwner(owner.id);

      expect(appended.revision).toBe(before.revision);
      expect(updated.data.comments).toEqual(appended.data.comments);
      expect(after).toEqual({
        task: owner.key,
        revision: owner.revision + 1,
        items: appended.data.comments,
      });
      expect(before.items).toEqual(owner.data.comments);
      const generation = db.getGeneration();
      await expectAsyncRelayError(
        () =>
          tasks.update(
            owner.id,
            { title: updated.data.title },
            { actor: "редактор", ifRevision: before.revision },
          ),
        "REVISION_CONFLICT",
      );
      expect(tasks.get(owner.id)).toEqual(updated);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(["dependenciesWithOwner", "criteriaWithOwner", "commentsWithOwner"] as const)(
    "%s возвращает владельца и пустой состав без потери ревизии",
    async (method) => {
      await withEntityDatabase(async (db) => {
        const tasks = new TasksService(db);
        const owner = await tasks.create({}, "автор");

        expect(tasks[method](owner.id)).toEqual({
          task: owner.key,
          revision: owner.revision,
          items: [],
        });
      });
    },
  );

  test.each(ownerReads)("$name отвергает отсутствующего владельца как NOT_FOUND", ({ read }) => {
    withEntityDatabase((db) => {
      const generation = db.getGeneration();

      const failure = expectRelayError(
        () => read(new TasksService(db), "PRODUCT-404"),
        "NOT_FOUND",
      );

      expect(failure.details).toEqual({ ref: "PRODUCT-404", kind: "task" });
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(ownerReads)(
    "$name проверяет полную карточку и сохраняет повреждённые данные",
    async ({ read }) => {
      await withEntityDatabase(async (db) => {
        const tasks = new TasksService(db);
        const owner = await createNestedTask(tasks);
        // Поле вне выбранного вложенного состава повреждено намеренно через Storage.
        const corrupted = {
          ...owner,
          revision: owner.revision + 1,
          data: { ...owner.data, description: null },
        };
        db.update(corrupted, owner.revision);
        const generation = db.getGeneration();

        expectRelayError(() => read(tasks, owner.id), "CORRUPT_DATA");

        expect(db.get(owner.id)).toEqual(corrupted);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("чужой критерий не принимается за критерий указанного владельца", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const owner = await tasks.create({}, "автор");
      const other = await createNestedTask(tasks);
      const [criterion] = other.data.acceptanceCriteria;
      assert(criterion);
      const generation = db.getGeneration();

      const failure = expectRelayError(
        () => tasks.getCriterionWithOwner(owner.id, criterion.id),
        "NOT_FOUND",
      );

      expect(failure.details).toEqual({ id: criterion.id });
      expect(tasks.get(owner.id)).toEqual(owner);
      expect(tasks.get(other.id)).toEqual(other);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("отсутствующая зависимость отвергает весь состав без частичного результата", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const dependency = await tasks.create({}, "автор");
      const owner = await tasks.create({ dependencies: [dependency.id] }, "автор");
      // Имитируем внешнее повреждение постоянной ссылки после валидного элемента состава.
      const corrupted = {
        ...owner,
        revision: owner.revision + 1,
        data: { ...owner.data, dependencies: [dependency.id, "missing-task"] },
      };
      db.update(corrupted, owner.revision);
      const generation = db.getGeneration();

      expectRelayError(() => tasks.dependenciesWithOwner(owner.id), "NOT_FOUND");

      expect(db.get(owner.id)).toEqual(corrupted);
      expect(tasks.get(dependency.id)).toEqual(dependency);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("повреждённая зависимость отвергает весь состав и сохраняет обе задачи", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const dependency = await tasks.create({}, "автор");
      const owner = await tasks.create({ dependencies: [dependency.id] }, "автор");
      const corrupted = {
        ...dependency,
        revision: dependency.revision + 1,
        data: { ...dependency.data, description: null },
      };
      // Повреждение цели нельзя получить штатной мутацией Core.
      db.update(corrupted, dependency.revision);
      const generation = db.getGeneration();

      expectRelayError(() => tasks.dependenciesWithOwner(owner.id), "CORRUPT_DATA");

      expect(db.get(dependency.id)).toEqual(corrupted);
      expect(tasks.get(owner.id)).toEqual(owner);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});
