import { describe, expect, test } from "bun:test";
import { RelayError, type ReleaseRecord, type WorkPlanRecord } from "@relay/contracts";
import { TaskGraphCache } from "../tasks/task-command-graph";
import { calculatePlanningCreation, calculatePlanningUpdate } from "./planning-command-calculate";
import { calculatePlanTransition, calculateReleaseTransition } from "./planning-command-lifecycle";
import { assertPlanningTransition } from "./planning-transition";

const actor = "planning-validator";
const timestamp = "2026-10-24T00:00:00.000Z";
const metadata = {
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: actor,
  updatedBy: actor,
  revision: 1,
};
const open: WorkPlanRecord = {
  ...metadata,
  id: "plan",
  key: "PLN-1",
  kind: "work-plan",
  data: {
    projectId: "project",
    title: "План",
    summary: "",
    goal: "Проверить выпуск",
    rationale: "",
    boundaries: "",
    expectedResult: "",
    participants: [],
    scope: [],
    result: "",
    status: "draft",
    startedAt: null,
    closedAt: null,
    stages: [
      {
        id: "stage",
        title: "Работа",
        summary: "",
        outcome: "",
        completionConditions: "",
        taskIds: ["task"],
      },
    ],
  },
};
const release: ReleaseRecord = {
  ...metadata,
  id: "release",
  key: "REL-1",
  kind: "release",
  data: {
    projectId: "project",
    title: "Выпуск",
    version: "1",
    summary: "",
    description: "",
    plannedFor: "",
    planIds: [open.id],
    status: "planned",
    releasedAt: null,
    releasedBy: null,
  },
};
const task = {
  ...metadata,
  id: "task",
  key: "TASK-1",
  kind: "task" as const,
  data: { column: "done", parentId: null, dependencies: [], acceptanceCriteria: [] },
};
const missingStageOperations = ["plan.stage.update", "plan.stage.move"] as const;

/**
 * Проверяет именно предметный код чистого отказа, исключая случайный TypeError.
 */
function rejected(operation: () => void, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Ожидалась ошибка ${code}`);
}

describe("Проверка готовых переходов планирования", () => {
  test.each(missingStageOperations)(
    "%s: no-op не принимает этап другого владельца",
    (operation) => {
      const other = {
        ...open,
        id: "other",
        key: "PLN-2",
        data: {
          ...open.data,
          stages: open.data.stages.map((stage) => ({ ...stage, id: "foreign-stage" })),
        },
      };

      rejected(
        () =>
          assertPlanningTransition(open, open, {
            operation,
            actor,
            stageId: "foreign-stage",
            plans: [other],
          }),
        "NOT_FOUND",
      );
      expect(open.data.stages.map((stage) => stage.id)).toEqual(["stage"]);
    },
  );

  test("no-op перемещения проверяет before в том же плане, но допускает before самого себя", () => {
    rejected(
      () =>
        assertPlanningTransition(open, open, {
          operation: "plan.stage.move",
          actor,
          stageId: "stage",
          beforeStageId: "foreign-stage",
        }),
      "NOT_FOUND",
    );

    expect(() =>
      assertPlanningTransition(open, open, {
        operation: "plan.stage.move",
        actor,
        stageId: "stage",
        beforeStageId: "stage",
      }),
    ).not.toThrow();
  });

  test("no-op named stage update требует явный ID этапа", () => {
    rejected(
      () => assertPlanningTransition(open, open, { operation: "plan.stage.update", actor }),
      "CORRUPT_DATA",
    );
  });

  test("no-op исключения требует существующую выбранную задачу, но допускает отсутствие её включения", () => {
    rejected(
      () =>
        assertPlanningTransition(open, open, {
          operation: "plan.stage.task.remove",
          actor,
          stageId: "stage",
          taskId: "missing",
          taskIds: new Set(["task"]),
        }),
      "NOT_FOUND",
    );

    expect(() =>
      assertPlanningTransition(open, open, {
        operation: "plan.stage.task.remove",
        actor,
        stageId: "stage",
        taskId: "other-existing",
        taskIds: new Set(["task", "other-existing"]),
      }),
    ).not.toThrow();
    expect(open.data.stages[0]?.taskIds).toEqual(["task"]);
  });

  test("no-op переноса проверяет владельца targetStage, даже если такой stage существует у источника", () => {
    const target = {
      ...open,
      id: "target",
      key: "PLN-2",
      data: {
        ...open.data,
        stages: open.data.stages.map((stage) => ({ ...stage, id: "target-stage" })),
      },
    };

    rejected(
      () =>
        assertPlanningTransition(open, open, {
          operation: "plan.stage.task.transfer",
          actor,
          sourcePlanId: open.id,
          taskId: "task",
          taskIds: new Set(["task"]),
          targetPlanId: target.id,
          targetStageId: "stage",
          plans: [target],
          memberships: [target],
        }),
      "NOT_FOUND",
    );
  });

  test("no-op переноса не скрывает отсутствующий targetPlan, а перенос в свой текущий этап допустим", () => {
    rejected(
      () =>
        assertPlanningTransition(open, open, {
          operation: "plan.stage.task.transfer",
          actor,
          sourcePlanId: open.id,
          taskId: "task",
          taskIds: new Set(["task"]),
          targetPlanId: "missing",
          targetStageId: "stage",
          memberships: [],
        }),
      "NOT_FOUND",
    );

    expect(() =>
      assertPlanningTransition(open, open, {
        operation: "plan.stage.task.transfer",
        actor,
        sourcePlanId: open.id,
        taskId: "task",
        taskIds: new Set(["task"]),
        targetPlanId: open.id,
        targetStageId: "stage",
        memberships: [],
      }),
    ).not.toThrow();
  });

  test("cancelled → released запрещён даже для готовых завершённых планов", () => {
    const cancelled = { ...release, data: { ...release.data, status: "cancelled" as const } };
    const completed = {
      ...open,
      data: {
        ...open.data,
        status: "completed" as const,
        closedAt: timestamp,
        result: "Выполнено",
      },
    };
    const published = {
      ...release,
      data: {
        ...release.data,
        status: "released" as const,
        releasedAt: timestamp,
        releasedBy: actor,
      },
    };

    rejected(
      () =>
        assertPlanningTransition(cancelled, published, {
          operation: "replication",
          actor,
          plans: [completed],
          taskProgress: new Map([["task", { completed: true, canComplete: true, blockers: [] }]]),
        }),
      "INVALID_TRANSITION",
    );
    expect(cancelled.data.status).toBe("cancelled");
  });

  test("active → draft и подмена lifecycle обычной правкой запрещены", () => {
    const active = {
      ...open,
      data: { ...open.data, status: "active" as const, startedAt: timestamp },
    };

    rejected(
      () => assertPlanningTransition(active, open, { operation: "replication", actor }),
      "INVALID_TRANSITION",
    );
    rejected(
      () => assertPlanningTransition(open, active, { operation: "plan.update", actor }),
      "INVALID_TRANSITION",
    );
  });

  test("no-op этапа закрытого плана не обходит запрет readonly", () => {
    const closed = {
      ...open,
      data: { ...open.data, status: "completed" as const, closedAt: timestamp, result: "Готово" },
    };

    rejected(
      () => assertPlanningTransition(closed, closed, { operation: "plan.stage.move", actor }),
      "PLAN_READ_ONLY",
    );
  });

  test("снятие непустого этапа и изменение состава под видом правки текста запрещены", () => {
    const removed = { ...open, data: { ...open.data, stages: [] } };
    const changed = {
      ...open,
      data: { ...open.data, stages: open.data.stages.map((stage) => ({ ...stage, taskIds: [] })) },
    };

    rejected(
      () => assertPlanningTransition(open, removed, { operation: "replication", actor }),
      "STAGE_NOT_EMPTY",
    );
    rejected(
      () =>
        assertPlanningTransition(open, changed, {
          operation: "plan.stage.update",
          actor,
          stageId: "stage",
        }),
      "INVALID_TRANSITION",
    );
  });

  test("повтор включения проверяет конкурирующего владельца даже при пустом эффекте", () => {
    const other = { ...open, id: "other", key: "PLN-2" };

    rejected(
      () =>
        assertPlanningTransition(open, open, {
          operation: "plan.stage.task.add",
          actor,
          memberships: [other],
          taskIds: new Set(["task"]),
          stageId: "stage",
          taskId: "task",
        }),
      "MEMBERSHIP_CONFLICT",
    );
  });

  test("чистые complete/publish используют готовый граф, поздний reopen не меняет факт выпуска", () => {
    const cache = new TaskGraphCache();
    const completed = calculatePlanTransition(
      open,
      { action: "complete", result: "Готово" },
      [task],
      cache,
      { actor, ifRevision: open.revision },
      timestamp,
    );
    const published = calculateReleaseTransition(
      release,
      "publish",
      [completed.record],
      [task],
      cache,
      { actor, ifRevision: release.revision },
      timestamp,
    );
    const reopenedGraph = cache.get([{ ...task, data: { ...task.data, column: "ready" } }]);

    expect(completed.record.data.status).toBe("completed");
    expect(published.record.data).toMatchObject({
      status: "released",
      releasedAt: timestamp,
      releasedBy: actor,
    });
    expect(reopenedGraph.progress(task.id).completed).toBe(false);
    expect(published.effects).toHaveLength(1);
    expect(open.data.status).toBe("draft");
    expect(release.data.status).toBe("planned");
  });

  test("правка заголовка не требует graph и сохраняет исходные данные calculator", () => {
    const created = calculatePlanningCreation(
      { kind: "work-plan", fields: { title: "Черновик" }, scope: [] },
      { id: "fresh", key: "PLN-3", projectId: "project", actor, timestamp },
    );
    const updated = calculatePlanningUpdate(
      created.record,
      { kind: "work-plan", fields: { title: "Уточнение" }, scope: [] },
      { actor, ifRevision: 1 },
      timestamp,
    );

    expect(created.record.data.title).toBe("Черновик");
    expect(updated.record.data.title).toBe("Уточнение");
    expect(updated.record.revision).toBe(2);
  });
});
