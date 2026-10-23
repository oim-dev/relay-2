import { describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import type { TaskComment, TaskCriterion, TaskRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import type { TaskCollection } from "../../src/tasks/task-read.types";
import { TasksService } from "../../src/tasks/tasks";
import { entityWriteOptions, expectRelayError, withEntityDatabase } from "./helpers/entity-fixture";

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
function createNestedTask(tasks: TasksService): TaskRecord {
  const task = tasks.create(
    {
      title: "Приёмка и обсуждение",
      acceptanceCriteria: [
        { title: "Первый", summary: "Условие", description: "## Проверка\n\n  результат\n" },
        { title: "Второй" },
      ],
    },
    "автор",
  );
  tasks.comment(task.id, "## Первый\n\n  точный отступ\n", "рецензент");
  return tasks.comment(task.id, "Второй комментарий", "другой автор", "Ответ");
}

describe("Составные чтения владельца и вложенных данных задачи", () => {
  test.each([
    { method: "criteriaWithOwner", field: "acceptanceCriteria" },
    { method: "commentsWithOwner", field: "comments" },
  ] as const)(
    "$method читает владельца один раз и сохраняет полный состав",
    ({ method, field }) => {
      withEntityDatabase((db) => {
        const tasks = new TasksService(db);
        const owner = createNestedTask(tasks);
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

  test("критерий возвращается с ревизией владельца после одного полного чтения", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const initial = createNestedTask(tasks);
      const [criterion] = initial.data.acceptanceCriteria;
      assert(criterion);
      const owner = tasks.criterion(
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

  test("зависимости сохраняют порядок и полные журналы с одним чтением владельца по алиасу", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const first = tasks.create({ title: "Первая созданная" }, "автор");
      const second = createNestedTask(tasks);
      const initial = tasks.create({ dependencies: [second.id, first.id] }, "автор");
      const application = new KnowledgeService(db).create(
        "application",
        { name: "Приложение", slug: "web" },
        "автор",
      );
      const owner = tasks.move(
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

  test("владелец и зависимости остаются в одном снимке при коммите между их чтениями", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const dependency = tasks.create({ title: "Исходное обязательство" }, "автор");
      const owner = tasks.create({ dependencies: [dependency.id] }, "автор");
      const peer = ProjectDatabase.open(db.path);
      try {
        const competingTasks = new TasksService(peer);
        /**
         * Сохраняет настоящее чтение снимка перед синхронизированной записью второго соединения.
         */
        const read: ProjectDatabase["get"] = db.get.bind(db);
        let changed = false;
        const interception = spyOn(db, "get").mockImplementation((ref, kind) => {
          const record = read(ref, kind);
          if (ref === owner.id && !changed) {
            changed = true;
            // Коммит после чтения владельца, но до чтения его зависимости.
            peer.transaction(() => {
              competingTasks.update(owner.id, { title: "Новая задача" }, entityWriteOptions(owner));
              competingTasks.update(
                dependency.id,
                { title: "Новое обязательство" },
                entityWriteOptions(dependency),
              );
              competingTasks.comment(dependency.id, "Позднее сообщение", "рецензент");
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

  test("ревизия составного чтения допускает запись после append, сохраняя журнал и CAS", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const owner = createNestedTask(tasks);
      const before = tasks.commentsWithOwner(owner.id);
      const appended = tasks.comment(owner.id, "После чтения", "рецензент");

      const updated = tasks.update(
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
      expectRelayError(
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
    (method) => {
      withEntityDatabase((db) => {
        const tasks = new TasksService(db);
        const owner = tasks.create({}, "автор");

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
    ({ read }) => {
      withEntityDatabase((db) => {
        const tasks = new TasksService(db);
        const owner = createNestedTask(tasks);
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

  test("чужой критерий не принимается за критерий указанного владельца", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const owner = tasks.create({}, "автор");
      const other = createNestedTask(tasks);
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

  test("отсутствующая зависимость отвергает весь состав без частичного результата", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const dependency = tasks.create({}, "автор");
      const owner = tasks.create({ dependencies: [dependency.id] }, "автор");
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

  test("повреждённая зависимость отвергает весь состав и сохраняет обе задачи", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const dependency = tasks.create({}, "автор");
      const owner = tasks.create({ dependencies: [dependency.id] }, "автор");
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
