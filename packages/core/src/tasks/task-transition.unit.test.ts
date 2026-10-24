import { describe, expect, test } from "bun:test";
import type { TaskCriterion, TaskRecord } from "@relay/contracts";
import { TaskGraphCache } from "./task-command-graph";
import { newCriterion, parseCreateTask } from "./task-input";
import { parseTaskCriterionChange } from "./task-criterion-input";
import { assertTaskTransition } from "./task-transition";

const completed: TaskRecord = {
  id: "task",
  key: "TASK-1",
  kind: "task",
  revision: 1,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  createdBy: "author",
  updatedBy: "author",
  data: {
    boardId: "board",
    title: "Итог",
    description: "",
    column: "done",
    parentId: null,
    dependencies: ["dependency"],
    related: [],
    targets: [],
    acceptanceCriteria: [],
    comments: [],
  },
};

const acceptedCriterion: TaskCriterion = {
  id: "criterion",
  title: "Исходное условие",
  summary: "Кратко",
  description: "Проверка",
  completed: true,
  completedAt: "2026-10-23T12:00:00.000Z",
  completedBy: "first-reviewer",
};

/**
 * Готовит открытую задачу с явно выбранным составом, чтобы проверять переход без графа/БД.
 */
function taskWithCriteria(acceptanceCriteria: TaskCriterion[]): TaskRecord {
  return {
    ...completed,
    data: { ...completed.data, column: "ready", dependencies: [], acceptanceCriteria },
  };
}

describe("Чистые основания переходов задачи", () => {
  test("разбор критериев детерминирован и не выделяет ID до allocation", () => {
    const input = { acceptanceCriteria: [{ title: "Проверка" }] };

    const first = parseCreateTask(input);
    const second = parseCreateTask(input);
    const addition = parseTaskCriterionChange("add", { title: "Проверка" });

    expect(first).toEqual(second);
    expect(first.acceptanceCriteria).toEqual([{ title: "Проверка", summary: "", description: "" }]);
    expect(addition).toEqual({
      action: "add",
      content: { title: "Проверка", summary: "", description: "" },
    });
    expect(newCriterion({ title: "Проверка" }, "allocated-id")).toEqual({
      id: "allocated-id",
      title: "Проверка",
      summary: "",
      description: "",
      completed: false,
      completedAt: null,
      completedBy: null,
    });
  });

  test("правка текста исторического done не требует графа и повторного завершения", () => {
    const next = { ...completed, data: { ...completed.data, title: "Уточнение" } };

    expect(() => assertTaskTransition(completed, next, { operation: "task.update" })).not.toThrow();
    expect(() => assertTaskTransition(completed, next, { operation: "replication" })).not.toThrow();
  });

  test("явный повтор move done проверяет фактические обязательства, а title с тем же графом допустим", () => {
    const dependency: TaskRecord = {
      ...completed,
      id: "dependency",
      key: "TASK-2",
      data: { ...completed.data, dependencies: [], column: "ready" },
    };
    const graph = new TaskGraphCache().get([completed, dependency]);

    expect(() =>
      assertTaskTransition(completed, completed, { operation: "task.move", graph }),
    ).toThrow(expect.objectContaining({ code: "TASK_INCOMPLETE" }));
    expect(() =>
      assertTaskTransition(completed, completed, { operation: "task.update", graph }),
    ).not.toThrow();
  });

  test("новый невыполненный ребёнок done-родителя отвергается общим transition validator", () => {
    const parent = { ...completed, data: { ...completed.data, dependencies: [] } };
    const child: TaskRecord = {
      ...completed,
      id: "child",
      key: "TASK-2",
      data: { ...completed.data, dependencies: [], column: "ready" },
    };
    const candidate = { ...child, data: { ...child.data, parentId: parent.id } };
    const graph = new TaskGraphCache().get([parent, child], candidate);

    expect(() =>
      assertTaskTransition(child, candidate, { operation: "task.parent.set", graph }),
    ).toThrow(expect.objectContaining({ code: "TASK_DONE" }));
  });

  test.each(["title", "summary", "description"] as const)(
    "изменение %s не может сохранить приёмку прежнего текста",
    (field) => {
      const previous = taskWithCriteria([acceptedCriterion]);
      const next = taskWithCriteria([{ ...acceptedCriterion, [field]: "Изменённое условие" }]);

      expect(() =>
        assertTaskTransition(previous, next, {
          operation: "task.criterion.update",
          criterionId: acceptedCriterion.id,
        }),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          details: { id: acceptedCriterion.id },
        }),
      );
      expect(() => assertTaskTransition(previous, next, { operation: "replication" })).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(previous.data.acceptanceCriteria).toEqual([acceptedCriterion]);
    },
  );

  test.each([
    { name: "автора", patch: { completedBy: "other-reviewer" } },
    { name: "время", patch: { completedAt: "2026-10-24T12:00:00.000Z" } },
  ])("повторная приёмка не переписывает $name исходной отметки", ({ patch }) => {
    const previous = taskWithCriteria([acceptedCriterion]);
    const next = taskWithCriteria([{ ...acceptedCriterion, ...patch }]);

    expect(() =>
      assertTaskTransition(previous, next, {
        operation: "task.criterion.complete",
        criterionId: acceptedCriterion.id,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() =>
      assertTaskTransition(previous, previous, {
        operation: "task.criterion.complete",
        criterionId: acceptedCriterion.id,
        actor: "new-requester",
        timestamp: "2026-10-24T13:00:00.000Z",
      }),
    ).not.toThrow();
  });

  test.each([
    { name: "автор", patch: { completedBy: "other-actor" } },
    { name: "время", patch: { completedAt: "2026-10-25T01:00:00.000Z" } },
  ])(
    "новая отметка отвергается, если $name отличается от выделенных метаданных перехода",
    ({ patch }) => {
      const unaccepted = {
        ...acceptedCriterion,
        completed: false,
        completedAt: null,
        completedBy: null,
      };
      const previous = taskWithCriteria([unaccepted]);
      const context = {
        operation: "task.criterion.complete",
        criterionId: acceptedCriterion.id,
        actor: "step-author",
        timestamp: "2026-10-01T00:00:00.000Z",
      };
      const accepted = {
        ...acceptedCriterion,
        completedBy: context.actor,
        completedAt: context.timestamp,
      };
      const next = taskWithCriteria([{ ...accepted, ...patch }]);

      expect(() => assertTaskTransition(previous, next, context)).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          details: { id: acceptedCriterion.id },
        }),
      );
      // Дата раньше updatedAt допустима: проверяется согласованность allocation, а не порядок часов.
      expect(() =>
        assertTaskTransition(previous, taskWithCriteria([accepted]), context),
      ).not.toThrow();
    },
  );

  test("legacy-переход без исходных автора и часов сохраняет метаданные приёмки как факт", () => {
    const unaccepted = {
      ...acceptedCriterion,
      completed: false,
      completedAt: null,
      completedBy: null,
    };
    const previous = taskWithCriteria([unaccepted]);
    const next = taskWithCriteria([acceptedCriterion]);

    expect(() => assertTaskTransition(previous, next, { operation: "replication" })).not.toThrow();
    expect(next.data.acceptanceCriteria).toEqual([acceptedCriterion]);
  });

  test("добавленный критерий не может сразу иметь отметку приёмки", () => {
    const previous = taskWithCriteria([]);
    const next = taskWithCriteria([acceptedCriterion]);

    expect(() =>
      assertTaskTransition(previous, next, {
        operation: "task.criterion.add",
        criterionId: acceptedCriterion.id,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => assertTaskTransition(previous, next, { operation: "replication" })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });

  test.each(["update", "complete", "reopen", "remove"] as const)(
    "no-op %s проверяет именно явно выбранный criterionId",
    (action) => {
      const previous = taskWithCriteria([acceptedCriterion]);

      expect(() =>
        assertTaskTransition(previous, previous, {
          operation: `task.criterion.${action}`,
          criterionId: "missing-criterion",
        }),
      ).toThrow(
        expect.objectContaining({ code: "NOT_FOUND", details: { id: "missing-criterion" } }),
      );
      expect(() =>
        assertTaskTransition(previous, previous, {
          operation: `task.criterion.${action}`,
        }),
      ).toThrow(expect.objectContaining({ code: "CORRUPT_DATA" }));
    },
  );

  test("remove существующего критерия обязан удалить его, а не вернуть no-op", () => {
    const previous = taskWithCriteria([acceptedCriterion]);

    expect(() =>
      assertTaskTransition(previous, previous, {
        operation: "task.criterion.remove",
        criterionId: acceptedCriterion.id,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() =>
      assertTaskTransition(previous, taskWithCriteria([]), {
        operation: "task.criterion.remove",
        criterionId: acceptedCriterion.id,
      }),
    ).not.toThrow();
  });

  test("изменение текста сбрасывает отметку, после чего отдельная приёмка нового текста допустима", () => {
    const previous = taskWithCriteria([acceptedCriterion]);
    const updated: TaskCriterion = {
      ...acceptedCriterion,
      title: "Новое условие",
      completed: false,
      completedAt: null,
      completedBy: null,
    };
    const afterUpdate = taskWithCriteria([updated]);
    const afterComplete = taskWithCriteria([
      {
        ...updated,
        completed: true,
        completedAt: "2026-10-24T12:00:00.000Z",
        completedBy: "new-reviewer",
      },
    ]);

    expect(() =>
      assertTaskTransition(previous, afterUpdate, {
        operation: "task.criterion.update",
        criterionId: acceptedCriterion.id,
      }),
    ).not.toThrow();
    expect(() =>
      assertTaskTransition(afterUpdate, afterComplete, {
        operation: "task.criterion.complete",
        criterionId: acceptedCriterion.id,
      }),
    ).not.toThrow();
    expect(afterComplete.data.acceptanceCriteria).toEqual([
      {
        ...acceptedCriterion,
        title: "Новое условие",
        completedAt: "2026-10-24T12:00:00.000Z",
        completedBy: "new-reviewer",
      },
    ]);
  });

  test("именованная приёмка не меняет соседний критерий или порядок состава", () => {
    const selected: TaskCriterion = {
      ...acceptedCriterion,
      completed: false,
      completedAt: null,
      completedBy: null,
    };
    const neighbor = { ...selected, id: "neighbor", title: "Соседнее условие" };
    const previous = taskWithCriteria([selected, neighbor]);
    const next = taskWithCriteria([
      acceptedCriterion,
      { ...neighbor, title: "Подменённое условие" },
    ]);

    expect(() =>
      assertTaskTransition(previous, next, {
        operation: "task.criterion.complete",
        criterionId: selected.id,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT", details: { id: neighbor.id } }));
    expect(() =>
      assertTaskTransition(previous, taskWithCriteria([neighbor, acceptedCriterion]), {
        operation: "task.criterion.complete",
        criterionId: selected.id,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
