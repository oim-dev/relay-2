import { describe, expect, test } from "bun:test";
import { BatchService } from "../../src/batch/batch";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import { expectRelayError, withEntityDatabase } from "./helpers/entity-fixture";

const invalidTargetRevisions = [
  { name: "отсутствующий", stale: false, expectedCode: "INVALID_ARGUMENT" },
  { name: "устаревший", stale: true, expectedCode: "REVISION_CONFLICT" },
] as const;

describe("Владельцы вложенных действий пакета", () => {
  test.each(invalidTargetRevisions)(
    "$name targetRevision не подменяется актуальной ревизией при переносе внутри плана",
    ({ stale, expectedCode }) => {
      withEntityDatabase((db) => {
        const planning = new PlanningService(db);
        const task = new TasksService(db).create({ title: "Перенести" }, "author");
        const plan = planning.create("work-plan", { title: "План" }, "author");
        const first = planning.stage(
          plan.id,
          "create",
          { title: "Исходный этап" },
          { actor: "author", ifRevision: plan.revision },
        );
        const both = planning.stage(
          plan.id,
          "create",
          { title: "Целевой этап" },
          { actor: "author", ifRevision: first.revision },
        );
        const included = planning.stageTask(
          plan.id,
          both.data.stages[0]?.id ?? "missing",
          task.id,
          false,
          { actor: "author", ifRevision: both.revision },
        );
        const generation = db.getGeneration();

        const error = expectRelayError(
          () =>
            new BatchService(db).execute(
              {
                version: 1,
                operations: [
                  {
                    op: "plan.stage.task.transfer",
                    ref: plan.id,
                    ifRevision: included.revision,
                    input: {
                      task: task.id,
                      targetPlan: plan.id,
                      targetStage: both.data.stages[1]?.id,
                      ...(stale ? { targetRevision: included.revision - 1 } : {}),
                      reason: "Смена этапа",
                    },
                  },
                ],
              },
              { actor: "agent", operationKey: "missing-target-cas" },
            ),
          expectedCode,
        );

        expect(error.details).toMatchObject({
          index: 0,
          op: "plan.stage.task.transfer",
          path: "operations[0].input.targetRevision",
        });
        expect(planning.get("work-plan", plan.id)).toEqual(included);
        expect(db.getGeneration()).toBe(generation);
        expect(db.getBatchReceipt("missing-target-cas")).toBeUndefined();
      });
    },
  );

  test("checkpoint и fork возвращают собственные ID и ревизию родительской сессии", () => {
    withEntityDatabase((db) => {
      const history = new HistoryService(db);
      const session = history.start({ title: "Исследование" }, "agent");
      const runId = session.data.currentRunId;
      const result = new BatchService(db).execute(
        {
          version: 1,
          operations: [
            {
              op: "checkpoint.open",
              as: "intent",
              ref: session.id,
              ifRevision: session.revision,
              input: { runId, title: "Проверить контракт", body: "Начать проверку" },
            },
            {
              op: "checkpoint.save",
              as: "note",
              ref: { $ref: "intent" },
              ifRevision: { $revision: "intent" },
              input: { runId, title: "Промежуточный вывод", body: "Контракт изучен" },
            },
            {
              op: "session.fork",
              as: "child",
              ref: { $ref: "intent" },
              ifRevision: { $revision: "note" },
              input: { runId, title: "Детальная проверка" },
            },
          ],
        },
        { actor: "agent", operationKey: "history" },
      );

      expect(result.entities).toHaveLength(4);
      expect(result.items[0]).toMatchObject({
        kind: "work-checkpoint",
        revision: 1,
        owner: { id: session.id, revision: 2 },
      });
      expect(result.items[1]).toMatchObject({
        kind: "work-checkpoint",
        revision: 1,
        owner: { id: session.id, revision: 3 },
      });
      expect(result.items[2]).toMatchObject({
        kind: "work-session",
        revision: 1,
        owner: { id: session.id, revision: 4 },
      });
      const child = result.entities.find((entity) => entity.id === result.items[2]?.id);
      expect(child).toMatchObject({
        data: {
          status: "pending",
          parentSessionId: session.id,
          originCheckpointId: result.items[0]?.id,
        },
      });
      expect(result.entities.find((entity) => entity.id === session.id)?.revision).toBe(4);
      expect(new BatchService(db).getResult("history")).toEqual({ ...result, replayed: true });
    });
  });

  test("создание FI на существующем приложении требует исходную числовую ревизию", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const application = knowledge.create("application", { name: "Web", slug: "web" }, "author");
      const feature = knowledge.create("feature", { name: "Поиск" }, "author");
      const generation = db.getGeneration();
      const input = {
        version: 1,
        operations: [
          {
            op: "implementation.create",
            input: { application: application.id, target: feature.id, title: "FI" },
          },
        ],
      };

      expectRelayError(
        () =>
          new BatchService(db).execute(input, {
            actor: "agent",
            operationKey: "missing-owner-cas",
          }),
        "INVALID_ARGUMENT",
      );

      expect(knowledge.get("application", application.id)).toEqual(application);
      expect(db.count("implementation")).toBe(0);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("назначение реализации на чужую доску откатывает связанное создание", () => {
    withEntityDatabase((db) => {
      const before = db.list();
      const generation = db.getGeneration();

      const error = expectRelayError(
        () =>
          new BatchService(db).execute(
            {
              version: 1,
              operations: [
                { op: "feature.create", as: "feature", input: { name: "Поиск" } },
                {
                  op: "application.create",
                  as: "application",
                  input: { name: "Web", slug: "web" },
                },
                {
                  op: "implementation.create",
                  as: "fi",
                  ifRevision: { $revision: "application" },
                  input: {
                    application: { $ref: "application" },
                    target: { $ref: "feature" },
                    title: "FI",
                  },
                },
                {
                  op: "task.create",
                  input: {
                    board: "BOARD-PRODUCT",
                    title: "Неверная доска",
                    targets: [{ $ref: "fi" }],
                  },
                },
              ],
            },
            { actor: "agent", operationKey: "foreign-board" },
          ),
        "INVALID_ARGUMENT",
      );

      expect(error.details).toMatchObject({ index: 3, op: "task.create" });
      expect(db.list()).toEqual(before);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("структурированная ссылка проверяет именно объявленный kind и указывает вложенный путь", () => {
    withEntityDatabase((db) => {
      const generation = db.getGeneration();

      const error = expectRelayError(
        () =>
          new BatchService(db).execute(
            {
              version: 1,
              operations: [
                { op: "feature.create", as: "feature", input: { name: "Поиск" } },
                {
                  op: "plan.create",
                  input: {
                    title: "План",
                    scope: [{ kind: "application", id: { $ref: "feature" } }],
                  },
                },
              ],
            },
            { actor: "agent", operationKey: "scope-kind" },
          ),
        "INVALID_ARGUMENT",
      );

      expect(error.details).toMatchObject({
        index: 1,
        op: "plan.create",
        path: "operations[1].input.scope[0].id",
      });
      expect(db.count("feature")).toBe(0);
      expect(db.count("work-plan")).toBe(0);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("типизированный объект отношения разрешает виртуальный адрес доски без потери kind", () => {
    withEntityDatabase((db) => {
      const result = new BatchService(db).execute(
        {
          version: 1,
          operations: [
            { op: "application.create", input: { name: "Web", slug: "web" } },
            {
              op: "document.create",
              input: {
                name: "Доска",
                body: "Описание доски",
                relations: [{ target: { kind: "board", id: "web" } }],
              },
            },
          ],
        },
        { actor: "agent", operationKey: "board-relation" },
      );

      const board = result.entities.find((entity) => entity.kind === "board");
      expect(result.entities.find((entity) => entity.kind === "document")?.data.relations).toEqual([
        {
          target: { kind: "board", id: board?.id ?? "missing" },
          type: "documents",
          description: "",
        },
      ]);
    });
  });
});
