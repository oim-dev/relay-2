import { describe, expect, test } from "bun:test";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import { expectAsyncRelayError, withEntityDatabase } from "./helpers/entity-fixture";

const invalidSteps = [
  {
    name: "ссылка вперёд",
    step: { op: "scenario.create", input: { name: "Сценарий", feature: { $ref: "future" } } },
    code: "INVALID_ARGUMENT",
    path: "input.feature",
  },
  {
    name: "неверный вид локальной цели",
    step: { op: "scenario.create", input: { name: "Сценарий", feature: { $ref: "document" } } },
    code: "INVALID_ARGUMENT",
    path: "input.feature",
  },
  {
    name: "отсутствующая доска",
    step: { op: "task.create", input: { board: "board:missing", title: "Задача" } },
    code: "NOT_FOUND",
    path: "input.board",
  },
  {
    name: "невыполненный критерий done-задачи",
    step: {
      op: "task.create",
      input: { column: "done", acceptanceCriteria: [{ title: "Не выполнен" }] },
    },
    code: "TASK_INCOMPLETE",
    path: "input",
  },
] as const;

describe("Атомарность предметного пакета", () => {
  test.each(invalidSteps)(
    "$name откатывает сущности, комментарий, алиасы, счётчики и квитанцию",
    async ({ step, code, path }) => {
      await withEntityDatabase(async (db) => {
        const knowledge = new KnowledgeService(db);
        const original = await knowledge.create(
          "document",
          { name: "Старый", body: "Сохранить" },
          "author",
        );
        const task = await new TasksService(db).create({ title: "Исходная задача" }, "author");
        const before = db.list();
        const generation = db.getGeneration();
        const batch = new BatchService(db);
        const input = {
          version: 1,
          operations: [
            { op: "document.create", as: "document", input: { name: "Новый", body: "Отменить" } },
            {
              op: "document.rename",
              ref: original.id,
              ifRevision: original.revision,
              input: { key: "DOC-RENAMED" },
            },
            { op: "task.comment.add", ref: task.id, input: { body: "Отменить комментарий" } },
            step,
            // future объявлено позже: первый случай проверяет именно ссылку вперёд, а не неизвестное имя.
            { op: "feature.create", as: "future", input: { name: "Поздняя цель" } },
          ],
        };

        const error = await expectAsyncRelayError(
          () => batch.execute(input, { actor: "agent", operationKey: "rollback" }),
          code,
        );

        expect(error.details).toMatchObject({
          index: 3,
          op: step.op,
          path: `operations[3].${path}`,
        });
        expect(db.list()).toEqual(before);
        expect(db.getGeneration()).toBe(generation);
        expect(db.getIdentity("DOC-RENAMED")).toBeUndefined();
        expect(db.getBatchReceipt("rollback")).toBeUndefined();
        expect(
          (
            await knowledge.create(
              "document",
              { name: "После отката", body: "Содержание" },
              "author",
            )
          ).key,
        ).toBe("DOC-2");
      });
    },
  );

  test("устаревший CAS откатывает предшествующее создание без подстановки свежей ревизии", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const initial = await knowledge.create(
        "document",
        { name: "ТЗ", body: "Первая версия" },
        "author",
      );
      const current = await knowledge.update(
        "document",
        initial.id,
        { body: "Актуальная версия" },
        { actor: "editor", ifRevision: initial.revision },
      );
      const generation = db.getGeneration();

      const error = await expectAsyncRelayError(
        () =>
          new BatchService(db).execute(
            {
              version: 1,
              operations: [
                { op: "document.create", input: { name: "Не сохранять", body: "Текст" } },
                {
                  op: "document.update",
                  ref: initial.key,
                  ifRevision: initial.revision,
                  input: { documentStatus: "archived" },
                },
              ],
            },
            { actor: "agent", operationKey: "stale" },
          ),
        "REVISION_CONFLICT",
      );

      expect(error.details).toMatchObject({
        index: 1,
        op: "document.update",
        path: "operations[1].ifRevision",
        expectedRevision: 1,
        actualRevision: 2,
      });
      expect(db.list("document")).toEqual([current]);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getBatchReceipt("stale")).toBeUndefined();
    });
  });

  test("чужая ревизия критерия отклоняется и при совпадении чисел у двух авторизованных владельцев", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const first = await tasks.create({ title: "Первая" }, "author");
      const second = await tasks.create({ title: "Вторая" }, "author");
      const before = db.list("task");
      const generation = db.getGeneration();

      const error = await expectAsyncRelayError(
        () =>
          new BatchService(db).execute(
            {
              version: 1,
              operations: [
                {
                  op: "task.update",
                  ref: second.id,
                  ifRevision: second.revision,
                  input: { title: "Вторая после исходного CAS" },
                },
                {
                  op: "task.criterion.add",
                  ref: first.id,
                  as: "criterion",
                  ifRevision: first.revision,
                  input: { title: "Критерий" },
                },
                {
                  op: "task.update",
                  ref: second.id,
                  ifRevision: { $revision: "criterion" },
                  input: { title: "Чужая ревизия" },
                },
              ],
            },
            { actor: "agent", operationKey: "wrong-owner" },
          ),
        "INVALID_ARGUMENT",
      );

      // Обе задачи уже прошли числовой CAS и имеют ревизию 2: отказ должен защищать именно владельца.
      expect(error.details).toMatchObject({ index: 2, path: "operations[2].ifRevision" });
      expect(db.list("task")).toEqual(before);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getBatchReceipt("wrong-owner")).toBeUndefined();
    });
  });

  test("комментарий не даёт скрытый CAS первой правки существующей задачи", async () => {
    await withEntityDatabase(async (db) => {
      const task = await new TasksService(db).create({ title: "Исходная" }, "author");
      const generation = db.getGeneration();

      const error = await expectAsyncRelayError(
        () =>
          new BatchService(db).execute(
            {
              version: 1,
              operations: [
                {
                  op: "task.comment.add",
                  ref: task.id,
                  as: "comment",
                  input: { body: "Наблюдение" },
                },
                {
                  op: "task.update",
                  ref: task.id,
                  ifRevision: { $revision: "comment" },
                  input: { title: "Без исходного CAS" },
                },
              ],
            },
            { actor: "agent", operationKey: "comment-cas" },
          ),
        "INVALID_ARGUMENT",
      );

      expect(error.details).toMatchObject({ index: 1, path: "operations[1].ifRevision" });
      expect(db.get(task.id)).toEqual(task);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("check выполняет смешанные изменения, полностью откатывает и не расходует ключ", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const existing = await knowledge.create(
        "document",
        { name: "Предыдущая спецификация", body: "Старый текст" },
        "author",
      );
      const task = await new TasksService(db).create({ title: "Работа" }, "author");
      const before = db.list();
      const generation = db.getGeneration();
      const input = {
        version: 1,
        operations: [
          { op: "document.create", input: { name: "Новая спецификация", body: "Новый текст" } },
          {
            op: "document.update",
            ref: existing.id,
            ifRevision: existing.revision,
            input: { documentStatus: "archived" },
          },
          { op: "task.comment.add", ref: task.id, input: { body: "Спецификация опубликована" } },
        ],
      };
      const batch = new BatchService(db);

      const checked = await batch.execute(input, {
        actor: "agent",
        operationKey: "publication",
        check: true,
      });

      expect(checked.status).toBe("checked");
      expect(checked.entities.find((entity) => entity.id === existing.id)).toMatchObject({
        data: { documentStatus: "archived" },
      });
      expect(db.list()).toEqual(before);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getBatchReceipt("publication")).toBeUndefined();
      const applied = await batch.execute(input, { actor: "agent", operationKey: "publication" });
      expect(applied.status).toBe("committed");
      expect(applied.items[0]?.key).toBe(checked.items[0]?.key);
      expect(applied.items[0]?.id).not.toBe(checked.items[0]?.id);
      expect(new TasksService(db).get(task.id)).toMatchObject({
        revision: task.revision,
        data: { comments: [{ body: "Спецификация опубликована" }] },
      });
    });
  });

  test("повторная ссылка на устаревшую локальную ревизию не обновляется автоматически", async () => {
    await withEntityDatabase(async (db) => {
      const batch = new BatchService(db);
      const generation = db.getGeneration();

      await expectAsyncRelayError(
        () =>
          batch.execute(
            {
              version: 1,
              operations: [
                { op: "task.create", as: "task" },
                {
                  op: "task.update",
                  ref: { $ref: "task" },
                  ifRevision: { $revision: "task" },
                  input: { title: "Изменено" },
                },
                {
                  op: "task.update",
                  ref: { $ref: "task" },
                  ifRevision: { $revision: "task" },
                  input: { title: "Устаревшее" },
                },
              ],
            },
            { actor: "agent", operationKey: "old-local" },
          ),
        "REVISION_CONFLICT",
      );

      expect(db.count("task")).toBe(0);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});
