import { describe, expect, test } from "bun:test";
import type { PlanStage, WorkPlanRecord } from "@relay/contracts";
import { assertPlanningTransition } from "./planning-transition";

const stages: PlanStage[] = ["A", "B", "C"].map((id) => ({
  id,
  title: id,
  summary: "",
  outcome: "",
  completionConditions: "",
  taskIds: [],
}));
const wrongStageChanges = [
  {
    name: "update A меняет B",
    operation: "plan.stage.update",
    stageId: "A",
    after: stages.map((stage) => (stage.id === "B" ? { ...stage, title: "Подмена" } : stage)),
  },
  {
    name: "move A переставляет B/C",
    operation: "plan.stage.move",
    stageId: "A",
    after: [stages[0], stages[2], stages[1]],
  },
  {
    name: "remove A снимает B",
    operation: "plan.stage.remove",
    stageId: "A",
    after: stages.filter((stage) => stage.id !== "B"),
  },
  {
    name: "create D меняет имя B",
    operation: "plan.stage.create",
    stageId: "D",
    after: [
      ...stages.map((stage) => (stage.id === "B" ? { ...stage, title: "Подмена" } : stage)),
      { id: "D", title: "D", summary: "", outcome: "", completionConditions: "", taskIds: [] },
    ],
  },
];

/**
 * Минимальная открытая карточка; каждое использование получает независимые вложенные массивы.
 */
function plan(): WorkPlanRecord {
  return {
    id: "plan",
    key: "PLN-1",
    kind: "work-plan",
    revision: 4,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    createdBy: "author",
    updatedBy: "author",
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
      result: "",
      status: "draft",
      startedAt: null,
      closedAt: null,
      stages: structuredClone(stages),
    },
  };
}

describe("Область pure перехода выбранного этапа", () => {
  test.each(wrongStageChanges)(
    "$name запрещено при корректном владельце",
    ({ operation, stageId, after }) => {
      const before = plan();
      const nextStages = after.map((stage) => {
        if (stage === undefined) {
          throw new Error("Неверный этап fixture");
        }
        return structuredClone(stage);
      });
      const next = { ...before, data: { ...before.data, stages: nextStages } };

      expect(() =>
        assertPlanningTransition(before, next, { operation, actor: "author", stageId }),
      ).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));
    },
  );

  test("правка A сохраняет канонический новый B и допускает метаданные записи", () => {
    const before = plan();
    before.data.stages = before.data.stages.map((stage) =>
      stage.id === "B" ? { ...stage, title: "Новый удалённый B", taskIds: ["unrelated"] } : stage,
    );
    const next = {
      ...before,
      revision: 8,
      updatedBy: "editor",
      updatedAt: "2026-10-24T01:00:00.000Z",
      data: {
        ...before.data,
        stages: before.data.stages.map((stage) =>
          stage.id === "A" ? { ...stage, title: "Новый A", outcome: "Итог" } : stage,
        ),
      },
    };

    expect(() =>
      assertPlanningTransition(before, next, {
        operation: "plan.stage.update",
        actor: "editor",
        stageId: "A",
      }),
    ).not.toThrow();
    expect(next.data.stages[1]).toEqual(before.data.stages[1]);
    expect(() =>
      assertPlanningTransition(
        before,
        { ...next, data: { ...next.data, title: "Чужое поле" } },
        { operation: "plan.stage.update", actor: "editor", stageId: "A" },
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));
  });

  test.each(["add", "remove"])(
    "task.%s не меняет соседнее включение при достигнутой цели",
    (action) => {
      const before = plan();
      if (action === "remove") {
        before.data.stages = before.data.stages.map((stage) => {
          if (stage.id === "A") {
            return { ...stage, taskIds: ["selected"] };
          }
          if (stage.id === "B") {
            return { ...stage, taskIds: ["other"] };
          }
          return stage;
        });
      }
      const selectedTasks = action === "add" ? ["selected"] : [];
      const next = {
        ...before,
        data: {
          ...before.data,
          stages: before.data.stages.map((stage) => {
            if (stage.id === "A") {
              return { ...stage, taskIds: selectedTasks };
            }
            if (stage.id === "B") {
              return { ...stage, taskIds: action === "add" ? ["other"] : [] };
            }
            return stage;
          }),
        },
      };

      expect(() =>
        assertPlanningTransition(before, next, {
          operation: `plan.stage.task.${action}`,
          actor: "author",
          stageId: "A",
          taskId: "selected",
          taskIds: new Set(["selected", "other"]),
          memberships: [],
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));
    },
  );

  test.each(["add", "remove"])("task.%s не меняет другую задачу того же этапа", (action) => {
    const before = plan();
    before.data.stages = before.data.stages.map((stage) =>
      stage.id === "A"
        ? {
            ...stage,
            taskIds: action === "add" ? ["selected"] : ["selected", "other"],
          }
        : stage,
    );
    const next = {
      ...before,
      data: {
        ...before.data,
        stages: before.data.stages.map((stage) =>
          stage.id === "A"
            ? {
                ...stage,
                taskIds: action === "add" ? ["selected", "other"] : [],
              }
            : stage,
        ),
      },
    };

    expect(() =>
      assertPlanningTransition(before, next, {
        operation: `plan.stage.task.${action}`,
        actor: "author",
        stageId: "A",
        taskId: "selected",
        taskIds: new Set(["selected", "other"]),
        memberships: [],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));
  });

  test("transfer внутри плана меняет два этапа только для выбранной задачи", () => {
    const before = plan();
    before.data.stages = before.data.stages.map((stage) => ({
      ...stage,
      taskIds: stage.id === "A" ? ["selected", "unrelated"] : [],
    }));
    const next = {
      ...before,
      data: {
        ...before.data,
        stages: before.data.stages.map((stage) => {
          if (stage.id === "A") {
            return { ...stage, taskIds: ["unrelated"] };
          }
          if (stage.id === "C") {
            return { ...stage, taskIds: ["selected"] };
          }
          return stage;
        }),
      },
    };
    const context = {
      operation: "plan.stage.task.transfer",
      actor: "author",
      sourcePlanId: before.id,
      targetPlanId: before.id,
      targetStageId: "C",
      taskId: "selected",
      taskIds: new Set(["selected", "unrelated"]),
      memberships: [],
    };

    expect(() => assertPlanningTransition(before, next, context)).not.toThrow();
    const damaged = {
      ...next,
      data: {
        ...next.data,
        stages: next.data.stages.map((stage) =>
          stage.id === "A" ? { ...stage, taskIds: [] } : stage,
        ),
      },
    };
    expect(() => assertPlanningTransition(before, damaged, context)).toThrow(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );
  });

  test("transfer внутри одного плана требует исходное включение выбранной задачи", () => {
    const before = plan();
    const added = {
      ...before,
      data: {
        ...before.data,
        stages: before.data.stages.map((stage) =>
          stage.id === "A" ? { ...stage, taskIds: ["selected"] } : stage,
        ),
      },
    };

    expect(() =>
      assertPlanningTransition(before, added, {
        operation: "plan.stage.task.transfer",
        actor: "author",
        sourcePlanId: before.id,
        targetPlanId: before.id,
        targetStageId: "A",
        taskId: "selected",
        taskIds: new Set(["selected"]),
        memberships: [],
      }),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});
