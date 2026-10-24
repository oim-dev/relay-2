import { describe, expect, test } from "bun:test";
import { BatchService } from "../../src/batch/batch";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import {
  entityWriteOptions,
  expectAsyncRelayError,
  withEntityDatabase,
} from "./helpers/entity-fixture";

describe("Предметная адаптация действий каталога batch", () => {
  test("parent.clear, dependency.remove и unlink снимают только выбранные связи задачи", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const parent = await tasks.create({ title: "Родитель" }, "author");
      const first = await tasks.create({ title: "Первая цель" }, "author");
      const second = await tasks.create({ title: "Вторая цель" }, "author");
      const task = await tasks.create(
        {
          title: "Изменяемые связи",
          parent: parent.id,
          dependencies: [first.id, second.id],
          related: [first.id, second.id],
        },
        "author",
      );

      const result = await new BatchService(db).execute(
        {
          version: 1,
          operations: [
            {
              op: "task.parent.clear",
              as: "root",
              ref: task.key,
              ifRevision: task.revision,
            },
            {
              op: "task.dependency.remove",
              as: "dependency-removed",
              ref: task.key,
              ifRevision: { $revision: "root" },
              input: { target: first.key },
            },
            {
              op: "task.unlink",
              ref: task.key,
              ifRevision: { $revision: "dependency-removed" },
              input: { target: second.key },
            },
          ],
        },
        { actor: "agent", operationKey: "remove-task-relations" },
      );

      const current = tasks.get(task.id);
      expect(current.data).toEqual({
        ...task.data,
        parentId: null,
        dependencies: [second.id],
        related: [first.id],
      });
      expect(current.revision).toBe(task.revision + 3);
      expect(result.entities).toEqual([current]);
      expect(result.items.map((item) => item.owner)).toEqual(
        [1, 2, 3].map((increment) => ({
          id: task.id,
          kind: "task",
          key: task.key,
          revision: task.revision + increment,
        })),
      );
    });
  });

  test("document.unlink передаёт тип снимаемой связи и сохраняет другую связь с той же целью", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Поиск" }, "author");
      const document = await knowledge.create(
        "document",
        {
          name: "Договорённость",
          body: "# Сохранить текст",
          relations: [
            { target: feature.key, type: "documents", description: "Сохраняемое основание" },
            { target: feature.key, type: "references", description: "Снимаемая ссылка" },
          ],
        },
        "author",
      );

      const result = await new BatchService(db).execute(
        {
          version: 1,
          operations: [
            {
              op: "document.unlink",
              ref: document.key,
              ifRevision: document.revision,
              input: { target: feature.key, type: "references" },
            },
          ],
        },
        { actor: "agent", operationKey: "unlink-document-type" },
      );

      const current = knowledge.get("document", document.id);
      expect(current.data).toEqual({
        ...document.data,
        relations: [
          {
            target: { kind: "feature", id: feature.id },
            type: "documents",
            description: "Сохраняемое основание",
          },
        ],
      });
      expect(current.revision).toBe(document.revision + 1);
      expect(result.entities).toEqual([current]);
      expect(result.items[0]?.owner).toEqual({
        id: document.id,
        kind: "document",
        key: document.key,
        revision: current.revision,
      });
    });
  });

  test("stage.update, move и remove адресуют нужные этапы и возвращают ревизии плана", async () => {
    await withEntityDatabase(async (db) => {
      const planning = new PlanningService(db);
      let plan = await planning.create("work-plan", { title: "Порядок этапов" }, "author");
      for (const title of ["Первый", "Удаляемый", "Перемещаемый"]) {
        plan = await planning.stage(plan.id, "create", { title }, entityWriteOptions(plan));
      }
      const [first, removed, moved] = plan.data.stages;
      if (first === undefined || removed === undefined || moved === undefined) {
        throw new Error("Для проверки маршрутизации нужны три исходных этапа");
      }
      const fields = {
        title: "Уточнённый этап",
        summary: "Сводка этапа",
        outcome: "## Проверенный результат",
        completionConditions: "Подтверждён порядок",
      };

      const result = await new BatchService(db).execute(
        {
          version: 1,
          operations: [
            {
              op: "plan.stage.update",
              as: "updated",
              ref: plan.key,
              ifRevision: plan.revision,
              input: { stageId: moved.id, ...fields },
            },
            {
              op: "plan.stage.move",
              as: "moved",
              ref: plan.key,
              ifRevision: { $revision: "updated" },
              input: { stageId: { $ref: "updated" }, before: first.id },
            },
            {
              op: "plan.stage.remove",
              ref: plan.key,
              ifRevision: { $revision: "moved" },
              input: { stageId: removed.id },
            },
          ],
        },
        { actor: "agent", operationKey: "stage-adapters" },
      );

      const current = planning.get("work-plan", plan.id);
      // После удаления среднего этапа no-op перемещения оставил бы обратный порядок двух остальных.
      expect(current.data).toEqual({ ...plan.data, stages: [{ ...moved, ...fields }, first] });
      expect(current.revision).toBe(plan.revision + 3);
      expect(result.entities).toEqual([current]);
      expect(result.items).toMatchObject(
        [moved.id, moved.id, removed.id].map((id, index) => ({
          id,
          kind: "plan-stage",
          key: null,
          revision: plan.revision + index + 1,
          owner: {
            id: plan.id,
            kind: "work-plan",
            key: plan.key,
            revision: plan.revision + index + 1,
          },
        })),
      );
    });
  });

  test("criterion.update и remove передают criterionId/id и возвращают ревизии задачи", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const task = await tasks.create(
        {
          title: "Приёмка",
          acceptanceCriteria: [
            { title: "Уточнить", summary: "Исходное условие", description: "Исходное описание" },
            { title: "Удалить" },
          ],
        },
        "author",
      );
      const [kept, removed] = task.data.acceptanceCriteria;
      if (kept === undefined || removed === undefined) {
        throw new Error("Для проверки адресации нужны два исходных критерия");
      }
      const fields = {
        title: "Уточнённый критерий",
        summary: "Новое условие",
        description: "# Подробное описание\n\nСохранить переводы строк.",
      };

      const result = await new BatchService(db).execute(
        {
          version: 1,
          operations: [
            {
              op: "task.criterion.update",
              as: "updated",
              ref: task.key,
              ifRevision: task.revision,
              input: { criterionId: kept.id, ...fields },
            },
            {
              op: "task.criterion.remove",
              ref: task.key,
              ifRevision: { $revision: "updated" },
              input: { id: removed.id },
            },
          ],
        },
        { actor: "agent", operationKey: "criterion-adapters" },
      );

      const current = tasks.get(task.id);
      expect(current.data).toEqual({ ...task.data, acceptanceCriteria: [{ ...kept, ...fields }] });
      expect(current.revision).toBe(task.revision + 2);
      expect(result.entities).toEqual([current]);
      expect(result.items).toMatchObject(
        [kept.id, removed.id].map((id, index) => ({
          id,
          kind: "task-criterion",
          key: null,
          revision: task.revision + index + 1,
          owner: {
            id: task.id,
            kind: "task",
            key: task.key,
            revision: task.revision + index + 1,
          },
        })),
      );
    });
  });

  test("product.create под числовым CAS заполняет существующий seed без нового ID", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const seed = knowledge.get("product");
      const count = db.count();
      const fields = { name: "Relay", summary: "Паспорт", description: "Рабочая память проекта" };

      const result = await new BatchService(db).execute(
        {
          version: 1,
          operations: [{ op: "product.create", ifRevision: seed.revision, input: fields }],
        },
        { actor: "agent", operationKey: "fill-product" },
      );

      const current = knowledge.get("product");
      expect(current).toMatchObject({
        id: seed.id,
        key: seed.key,
        revision: seed.revision + 1,
        createdAt: seed.createdAt,
        createdBy: seed.createdBy,
        updatedBy: "agent",
      });
      expect(current.data).toEqual(fields);
      expect(db.count()).toBe(count);
      expect(result.entities).toEqual([current]);
      expect(result.items[0]).toMatchObject({
        id: seed.id,
        kind: "product",
        key: seed.key,
        revision: seed.revision + 1,
        owner: { id: seed.id, kind: "product", key: seed.key, revision: seed.revision + 1 },
      });
    });
  });

  test("product.create отклоняет устаревший CAS раньше ALREADY_EXISTS заполненного продукта", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const seed = knowledge.get("product");
      const current = await knowledge.create("product", { name: "Уже заполнен" }, "author");
      const generation = db.getGeneration();

      const error = await expectAsyncRelayError(
        () =>
          new BatchService(db).execute(
            {
              version: 1,
              operations: [
                {
                  op: "product.create",
                  ifRevision: seed.revision,
                  input: { name: "Повторное заполнение" },
                },
              ],
            },
            { actor: "agent", operationKey: "stale-product" },
          ),
        "REVISION_CONFLICT",
      );

      expect(error.details).toMatchObject({
        id: seed.id,
        expectedRevision: seed.revision,
        actualRevision: current.revision,
        index: 0,
        op: "product.create",
        path: "operations[0].ifRevision",
      });
      expect(knowledge.get("product")).toEqual(current);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getBatchReceipt("stale-product")).toBeUndefined();
    });
  });

  test("session.start возвращает компактный run с ID текущего участия и ревизией сессии", async () => {
    await withEntityDatabase(async (db) => {
      const history = new HistoryService(db);

      const result = await new BatchService(db).execute(
        {
          version: 1,
          operations: [
            {
              op: "session.start",
              as: "session",
              input: {
                title: "Проверить адаптер",
                description: "Описание остаётся в полной карточке",
                client: "adapter-test",
                sourceSessionId: "external-session",
              },
            },
          ],
        },
        { actor: "agent", operationKey: "start-session" },
      );

      const [item] = result.items;
      if (item === undefined) {
        throw new Error("Отсутствует результат session.start");
      }
      const session = history.get(item.id);
      const [run] = session.data.runs;
      if (run === undefined) {
        throw new Error("Сессия должна содержать первое участие");
      }
      expect(session.data.runs).toHaveLength(1);
      expect(session.data.currentRunId).toBe(run.id);
      expect(run).toMatchObject({
        actor: "agent",
        client: "adapter-test",
        sourceSessionId: "external-session",
      });
      expect(result.entities).toEqual([session]);
      expect(result.items).toEqual([
        {
          index: 0,
          op: "session.start",
          as: "session",
          id: session.id,
          kind: "work-session",
          key: session.key,
          revision: 1,
          owner: {
            id: session.id,
            kind: "work-session",
            key: session.key,
            revision: session.revision,
          },
          outputs: [
            { name: "run", id: run.id, kind: "session-run", key: null, revision: session.revision },
          ],
        },
      ]);
    });
  });
});
