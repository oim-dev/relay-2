/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { BatchResult, WorkPlanRecord } from "@relay/contracts";
import { batchResponse, withAdapterHttp } from "domains/relay-data/testing/adapter-http";
import { changePlanStage, changePlanTasks, transferPlanTask } from "./planning.adapter";
import type { PlanningPlan, PlanStage } from "../types/planning.type";

const emptyProgress = {
  total: 0,
  done: 0,
  active: null,
  review: null,
  blocked: 0,
  percent: 0,
  completed: true,
};

/**
 * Создаёт самостоятельную UI-карточку: значимые ID и ревизия задаются самим тестом.
 */
function plan(id: string, revision: number): PlanningPlan {
  return {
    id,
    revision,
    key: `PLN-${id}`,
    title: "План",
    summary: "",
    goal: "",
    rationale: "",
    boundaries: "",
    expectedResult: "",
    participants: [],
    status: "draft",
    scope: [],
    scopeLabels: [],
    updatedAt: "2026-10-26T00:00:00.000Z",
    result: "",
    stageCount: 0,
    stagePreview: [],
    nextStageTitle: null,
    progress: { ...emptyProgress },
    isReady: true,
  };
}

/**
 * Собирает валидную запись владельца для подготовленной HTTP-квитанции, не выполняя команды.
 */
function storedPlan(id: string, revision: number): WorkPlanRecord {
  return {
    id,
    revision,
    kind: "work-plan",
    key: `PLN-${id}`,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:01:00.000Z",
    createdBy: "Автор сервера",
    updatedBy: "Автор сервера",
    data: {
      projectId: "project",
      title: "План",
      summary: "",
      goal: "",
      rationale: "",
      boundaries: "",
      expectedResult: "",
      participants: [],
      scope: [],
      stages: [],
      result: "",
      status: "draft",
      startedAt: null,
      closedAt: null,
    },
  };
}

/**
 * Создаёт этап с полным выбором задач; скрытые поиском ID остаются в taskIds.
 */
function stage(taskIds: string[]): PlanStage {
  return {
    id: "stage-source",
    title: "Этап",
    summary: "",
    outcome: "",
    completionConditions: "",
    taskIds,
    progress: { ...emptyProgress },
  };
}

describe("Команды адаптера планирования", () => {
  test("перенос передаёт разные исходные CAS обоих планов и возвращает владельца, а не вложенную задачу", async () => {
    const receipt: Omit<BatchResult, "operationKey"> = {
      status: "committed",
      replayed: false,
      items: [
        {
          index: 0,
          op: "plan.stage.task.transfer",
          as: null,
          id: "task",
          kind: "task",
          key: "TASK-1",
          revision: 3,
          owner: { id: "source", kind: "work-plan", key: "PLN-source", revision: 14 },
          outputs: [
            {
              name: "targetPlan",
              id: "target",
              kind: "work-plan",
              key: "PLN-target",
              revision: 42,
            },
          ],
        },
      ],
      entities: [storedPlan("source", 14), storedPlan("target", 42)],
    };

    const result = await withAdapterHttp(
      (request) => batchResponse(request, receipt),
      () =>
        transferPlanTask(
          "planning-transfer",
          plan("source", 13),
          plan("target", 41),
          "task",
          "stage-target",
          "Передать работу",
        ),
    );

    expect(result.value).toEqual({ id: "source", key: "PLN-source", revision: 14 });
    expect(result.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(await result.requests[1]?.json()).toEqual({
      actor: "Автор сервера",
      operationKey: expect.any(String),
      commands: [
        {
          op: "plan.stage.task.transfer",
          ref: "source",
          ifRevision: 13,
          input: {
            targetPlan: "target",
            targetRevision: 41,
            task: "task",
            targetStage: "stage-target",
            reason: "Передать работу",
          },
        },
      ],
    });
  });

  test("состав этапа сохраняется одним batch с $revision предыдущего шага и скрытой выбранной задачей", async () => {
    const receipt: Omit<BatchResult, "operationKey"> = {
      status: "committed",
      replayed: false,
      items: [
        {
          index: 0,
          op: "plan.stage.task.remove",
          as: "step0",
          id: "removed",
          kind: "task",
          key: "TASK-1",
          revision: 2,
          owner: { id: "source", kind: "work-plan", key: "PLN-source", revision: 14 },
          outputs: [],
        },
        {
          index: 1,
          op: "plan.stage.task.add",
          as: "step1",
          id: "added",
          kind: "task",
          key: "TASK-3",
          revision: 4,
          owner: { id: "source", kind: "work-plan", key: "PLN-source", revision: 15 },
          outputs: [],
        },
      ],
      entities: [
        {
          ...storedPlan("source", 15),
          data: {
            ...storedPlan("source", 15).data,
            stages: [
              {
                id: "stage-source",
                title: "Этап",
                summary: "",
                outcome: "",
                completionConditions: "",
                taskIds: ["hidden", "added"],
              },
            ],
          },
        },
      ],
    };

    const result = await withAdapterHttp(
      (request) => batchResponse(request, receipt),
      () =>
        changePlanTasks("planning-composition", "source", 13, stage(["removed", "hidden"]), [
          "hidden",
          "added",
        ]),
    );

    expect(result.value).toEqual({ id: "source", key: "PLN-source", revision: 15 });
    expect(result.requests).toHaveLength(2);
    expect(await result.requests[1]?.json()).toEqual({
      actor: "Автор сервера",
      operationKey: expect.any(String),
      commands: [
        {
          op: "plan.stage.task.remove",
          ref: "source",
          as: "step0",
          ifRevision: 13,
          input: { stageId: "stage-source", task: "removed" },
        },
        {
          op: "plan.stage.task.add",
          ref: "source",
          as: "step1",
          ifRevision: { $revision: "step0" },
          input: { stageId: "stage-source", task: "added" },
        },
      ],
    });
  });

  test("перемещение этапа передаёт CAS плана и null как явный конец списка", async () => {
    const record = storedPlan("source", 14);
    const receipt: Omit<BatchResult, "operationKey"> = {
      status: "committed",
      replayed: false,
      items: [
        {
          index: 0,
          op: "plan.stage.move",
          as: null,
          id: "stage-source",
          kind: "plan-stage",
          key: null,
          revision: 14,
          owner: { id: "source", kind: "work-plan", key: "PLN-source", revision: 14 },
          outputs: [],
        },
      ],
      entities: [record],
    };

    const result = await withAdapterHttp(
      (request) => batchResponse(request, receipt),
      () => changePlanStage("planning-stage", "source", 13, "move", stage([]), null),
    );

    expect(result.value).toEqual({ id: "source", key: "PLN-source", revision: 14 });
    expect(await result.requests[1]?.json()).toEqual({
      actor: "Автор сервера",
      operationKey: expect.any(String),
      commands: [
        {
          op: "plan.stage.move",
          ref: "source",
          ifRevision: 13,
          input: { stageId: "stage-source", before: null },
        },
      ],
    });
  });

  test("неизменённый состав не отправляет мутацию и не читает свежий CAS", async () => {
    const result = await withAdapterHttp(
      () => {
        throw new Error("Не ожидался HTTP");
      },
      () => changePlanTasks("planning-noop", "source", 13, stage(["hidden"]), ["hidden"]),
    );

    expect(result.value).toBeNull();
    expect(result.requests).toHaveLength(0);
  });
});
