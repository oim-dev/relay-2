import { describe, expect, test, spyOn } from "bun:test";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import { withEntityDatabase } from "./helpers/entity-fixture";

describe("Связанные предметные пакеты", () => {
  test("application → FI → SI → task сохраняет итоговых владельцев и не интерполирует Markdown", async () => {
    await withEntityDatabase(async (db) => {
      const batch = new BatchService(db);
      const body = '# Договорённости\n\n`{"$ref":"feature"}` — буквальный текст.\n';
      const input = {
        version: 1,
        operations: [
          { op: "feature.create", as: "feature", input: { name: "Бронирование" } },
          {
            op: "scenario.create",
            as: "scenario",
            input: { name: "Создать бронь", feature: { $ref: "feature" } },
          },
          {
            op: "application.create",
            as: "application",
            input: { name: "Booking", slug: "booking" },
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
            op: "implementation.create",
            as: "si",
            ifRevision: { $revision: "fi" },
            input: {
              application: { $ref: "application" },
              target: { $ref: "scenario" },
              title: "SI",
            },
          },
          {
            op: "task.create",
            as: "task",
            input: { board: "board:booking", title: "Реализовать", targets: [{ $ref: "si" }] },
          },
          {
            op: "document.create",
            as: "document",
            input: {
              name: "ТЗ",
              body,
              relations: [
                { target: { kind: "task", id: { $ref: "task" } }, type: "documents" },
                { target: { $ref: "feature" } },
              ],
            },
          },
          {
            op: "application.update",
            ref: { $ref: "application" },
            ifRevision: { $revision: "si" },
            input: { name: "Сервис бронирования" },
          },
        ],
      };
      const before = structuredClone(input);
      const loads = spyOn(db.commands, "load");
      const allRecords = spyOn(db, "list");
      try {
        const result = await batch.execute(input, { actor: "agent", operationKey: "booking" });

        expect(result.status).toBe("committed");
        expect(result.items).toHaveLength(8);
        expect(result.entities).toHaveLength(8);
        const feature = result.entities.find((record) => record.kind === "feature");
        const scenario = result.entities.find((record) => record.kind === "scenario");
        const application = result.entities.find((record) => record.kind === "application");
        const board = result.entities.find((record) => record.kind === "board");
        const fi = result.entities.find(
          (record) => record.kind === "implementation" && record.data.targetKind === "feature",
        );
        const si = result.entities.find(
          (record) => record.kind === "implementation" && record.data.targetKind === "scenario",
        );
        const task = result.entities.find((record) => record.kind === "task");
        const document = result.entities.find((record) => record.kind === "document");
        expect(scenario?.data.featureId).toBe(feature?.id);
        expect(application).toMatchObject({
          revision: 5,
          data: {
            name: "Сервис бронирования",
            boardId: board?.id,
            implementationIds: [fi?.id, si?.id].sort(),
          },
        });
        expect(board?.data.name).toBe("Сервис бронирования");
        expect(fi).toMatchObject({
          data: { targetId: feature?.id, applicationId: application?.id },
        });
        expect(si).toMatchObject({
          data: { targetId: scenario?.id, featureId: feature?.id, applicationId: application?.id },
        });
        expect(task).toMatchObject({
          key: "BOOKING-1",
          data: { boardId: board?.id, targets: [si?.id] },
        });
        expect(document).toMatchObject({
          data: {
            body,
            relations: [
              { target: { kind: "task", id: task?.id } },
              { target: { kind: "feature", id: feature?.id } },
            ],
          },
        });
        expect(result.items[3]).toMatchObject({
          id: fi?.id,
          revision: 1,
          owner: { id: application?.id, revision: 3 },
        });
        expect(result.items[4]?.owner.revision).toBe(4);
        expect(JSON.stringify(result.items)).not.toContain("Договорённости");
        expect(input).toEqual(before);
        const selectors = loads.mock.calls.flatMap(([request]) => request.selectors);
        expect(selectors.filter((selector) => selector.kind === "task-graph")).toHaveLength(1);
        expect(selectors.filter((selector) => selector.kind === "kind")).toEqual([]);
        expect(allRecords).not.toHaveBeenCalled();
      } finally {
        loads.mockRestore();
        allRecords.mockRestore();
      }
    });
  });

  test("план → этап → задачи и критерии используют последовательные ревизии владельцев", async () => {
    await withEntityDatabase(async (db) => {
      const result = await new BatchService(db).execute(
        {
          version: 1,
          operations: [
            { op: "task.create", as: "task", input: { title: "Проверить" } },
            {
              op: "task.criterion.add",
              ref: { $ref: "task" },
              as: "criterion",
              ifRevision: { $revision: "task" },
              input: { title: "Проверка пройдена" },
            },
            {
              op: "task.criterion.complete",
              ref: { $ref: "task" },
              as: "completed",
              ifRevision: { $revision: "criterion" },
              input: { id: { $ref: "criterion" } },
            },
            {
              op: "task.move",
              ref: { $ref: "task" },
              as: "done",
              ifRevision: { $revision: "completed" },
              input: { column: "done" },
            },
            {
              op: "plan.create",
              as: "plan",
              input: { title: "Приёмка", goal: "Подтвердить готовность" },
            },
            {
              op: "plan.stage.create",
              ref: { $ref: "plan" },
              as: "stage",
              ifRevision: { $revision: "plan" },
              input: { title: "Проверки" },
            },
            {
              op: "plan.stage.task.add",
              ref: { $ref: "plan" },
              as: "membership",
              ifRevision: { $revision: "stage" },
              input: { stageId: { $ref: "stage" }, task: { $ref: "task" } },
            },
            {
              op: "plan.start",
              ref: { $ref: "plan" },
              as: "active",
              ifRevision: { $revision: "membership" },
            },
            {
              op: "plan.complete",
              ref: { $ref: "plan" },
              ifRevision: { $revision: "active" },
              input: { result: "Всё выполнено" },
            },
          ],
        },
        { actor: "agent", operationKey: "acceptance" },
      );

      expect(result.entities).toHaveLength(2);
      const task = result.entities.find((record) => record.kind === "task");
      const plan = result.entities.find((record) => record.kind === "work-plan");
      if (plan === undefined) {
        throw new Error("Итоговый план отсутствует");
      }
      expect(task).toMatchObject({
        revision: 4,
        data: {
          column: "done",
          acceptanceCriteria: [{ id: result.items[1]?.id, completed: true, completedBy: "agent" }],
        },
      });
      expect(plan).toMatchObject({
        revision: 5,
        data: { status: "completed", stages: [{ id: result.items[5]?.id, taskIds: [task?.id] }] },
      });
      expect(result.items[1]).toMatchObject({
        kind: "task-criterion",
        owner: { id: task?.id, revision: 2 },
      });
      expect(result.items[5]).toMatchObject({
        kind: "plan-stage",
        owner: { id: plan?.id, revision: 2 },
      });
      expect(new PlanningService(db).get("work-plan", plan?.id ?? "missing")).toEqual(plan);
    });
  });

  test("перенос использует локальную ревизию второго владельца после числового CAS и возвращает оба плана", async () => {
    await withEntityDatabase(async (db) => {
      const planning = new PlanningService(db);
      const task = await new TasksService(db).create({ title: "Перенести" }, "author");
      const source = await planning.create("work-plan", { title: "Исходный" }, "author");
      const target = await planning.create("work-plan", { title: "Целевой" }, "author");
      const stagedSource = await planning.stage(
        source.id,
        "create",
        { title: "Этап" },
        { actor: "author", ifRevision: source.revision },
      );
      const stagedTarget = await planning.stage(
        target.id,
        "create",
        { title: "Приёмка" },
        { actor: "author", ifRevision: target.revision },
      );
      const included = await planning.stageTask(
        source.id,
        stagedSource.data.stages[0]?.id ?? "missing",
        task.id,
        false,
        { actor: "author", ifRevision: stagedSource.revision },
      );

      const result = await new BatchService(db).execute(
        {
          version: 1,
          operations: [
            {
              op: "plan.update",
              as: "target-checked",
              ref: target.id,
              ifRevision: stagedTarget.revision,
              input: { title: target.data.title },
            },
            {
              op: "plan.stage.task.transfer",
              ref: source.id,
              ifRevision: included.revision,
              input: {
                task: task.id,
                targetPlan: target.id,
                targetStage: stagedTarget.data.stages[0]?.id,
                targetRevision: { $revision: "target-checked" },
                reason: "Смена этапа",
              },
            },
          ],
        },
        { actor: "agent", operationKey: "transfer" },
      );

      expect(result.entities).toHaveLength(2);
      expect(planning.get("work-plan", source.id).data.stages[0]?.taskIds).toEqual([]);
      expect(planning.get("work-plan", target.id).data.stages[0]?.taskIds).toEqual([task.id]);
      expect(result.items[0]?.owner).toMatchObject({
        id: target.id,
        revision: stagedTarget.revision,
      });
      expect(result.items[1]?.outputs).toEqual([
        {
          name: "target",
          id: target.id,
          kind: "work-plan",
          key: target.key,
          revision: stagedTarget.revision + 1,
        },
      ]);
    });
  });

  test("замена участия возвращает неявно созданные и снятые реализации", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Поиск" }, "author");
      const application = await knowledge.create(
        "application",
        { name: "Web", slug: "web" },
        "author",
      );
      const batch = new BatchService(db);

      const created = await batch.execute(
        {
          version: 1,
          operations: [
            {
              op: "application.participation.replace",
              ref: application.id,
              ifRevision: application.revision,
              input: { targets: [feature.id] },
            },
          ],
        },
        { actor: "agent", operationKey: "participation" },
      );
      const current = knowledge.get("application", application.id);
      const removed = await batch.execute(
        {
          version: 1,
          operations: [
            {
              op: "application.participation.replace",
              ref: application.id,
              ifRevision: current.revision,
              input: { targets: [] },
            },
          ],
        },
        { actor: "agent", operationKey: "remove-participation" },
      );

      const implementation = created.entities.find((record) => record.kind === "implementation");
      expect(implementation).toMatchObject({ data: { targetId: feature.id, active: true } });
      expect(removed.entities.find((record) => record.kind === "implementation")).toMatchObject({
        id: implementation?.id,
        revision: 2,
        data: { active: false },
      });
      expect(
        removed.entities.find((record) => record.kind === "application")?.data.implementationIds,
      ).toEqual([]);
    });
  });
});
