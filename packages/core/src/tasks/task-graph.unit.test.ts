import { describe, expect, test } from "bun:test";
import { taskGraphNode } from "./task-data";
import { TaskGraph, type TaskGraphNode } from "./task-graph";

const columnCases = [
  {
    name: "done считается выполненной при выполненных обязательствах",
    column: "done",
    completed: true,
  },
  {
    name: "cancelled не считается выполнением обязательства",
    column: "cancelled",
    completed: false,
  },
  {
    name: "ready допускает завершение, но ещё не считается выполнением",
    column: "ready",
    completed: false,
  },
] as const;

const projection = {
  id: "task",
  key: "PRODUCT-1",
  data: {
    column: "done",
    parentId: null,
    dependencies: [],
    acceptanceCriteria: [{ completed: true }],
  },
} as const;

const corruptedProjectionCases = [
  { name: "неизвестная колонка", patch: { column: "other" } },
  { name: "null вместо зависимостей", patch: { dependencies: null } },
  { name: "нестроковый ID зависимости", patch: { dependencies: [null] } },
  { name: "нестроковый ID родителя", patch: { parentId: false } },
  { name: "отсутствующее поле родителя", patch: { parentId: undefined } },
  { name: "небулева отметка критерия", patch: { acceptanceCriteria: [{ completed: 1 }] } },
] as const;

/**
 * Создаёт минимальную выполненную задачу без обязательств; значимые поля задаёт конкретный тест.
 * Каждый вызов выделяет собственные массивы и не владеет внешними ресурсами.
 */
function createTaskGraphNode(
  id: string,
  fields: Partial<Omit<TaskGraphNode, "id">> = {},
): TaskGraphNode {
  return {
    id,
    column: "done",
    parentId: null,
    dependencies: [],
    acceptanceCriteria: [],
    ...fields,
  };
}

describe("Чистый граф задач", () => {
  test("невыполненный собственный критерий запрещает завершение без внешних блокеров", () => {
    const graph = new TaskGraph([
      createTaskGraphNode("task", { acceptanceCriteria: [{ completed: false }] }),
    ]);

    const progress = graph.progress("task");

    expect(progress).toEqual({ completed: false, canComplete: false, blockers: [] });
  });

  test("смешанные обязательства транзитивны, общий ребёнок-зависимость даёт один блокер", () => {
    const graph = new TaskGraph([
      createTaskGraphNode("root", { dependencies: ["middle"] }),
      createTaskGraphNode("middle", { dependencies: ["leaf"] }),
      createTaskGraphNode("leaf", {
        parentId: "middle",
        acceptanceCriteria: [{ completed: false }],
      }),
    ]);

    const root = graph.progress("root");
    const middle = graph.progress("middle");

    expect(root).toEqual({ completed: false, canComplete: false, blockers: ["middle"] });
    expect(middle).toEqual({ completed: false, canComplete: false, blockers: ["leaf"] });
  });

  test.each(columnCases)("$name", ({ column, completed }) => {
    const graph = new TaskGraph([createTaskGraphNode("task", { column })]);

    const progress = graph.progress("task");

    expect(progress).toEqual({ completed, canComplete: true, blockers: [] });
  });

  test("порядок блокеров сохраняет порядок связей, а не порядок топологического обхода", () => {
    const graph = new TaskGraph([
      createTaskGraphNode("root", { dependencies: ["intermediate", "leaf"] }),
      createTaskGraphNode("intermediate", { dependencies: ["leaf"] }),
      createTaskGraphNode("leaf", { column: "ready" }),
    ]);

    const progress = graph.progress("root");

    expect(progress).toEqual({
      completed: false,
      canComplete: false,
      blockers: ["intermediate", "leaf"],
    });
  });

  test("смешанный цикл родителя и зависимости отвергается как TASK_CYCLE", () => {
    const nodes = [
      createTaskGraphNode("parent"),
      createTaskGraphNode("child", { parentId: "parent", dependencies: ["parent"] }),
    ];

    expect(() => new TaskGraph(nodes)).toThrow(expect.objectContaining({ code: "TASK_CYCLE" }));
  });

  test("отсутствующий родитель отвергается как BROKEN_REFERENCE", () => {
    const nodes = [createTaskGraphNode("orphan", { parentId: "missing" })];

    expect(() => new TaskGraph(nodes)).toThrow(
      expect.objectContaining({
        code: "BROKEN_REFERENCE",
        details: { source: "missing", target: "orphan" },
      }),
    );
  });

  test("отсутствующая зависимость отвергается как BROKEN_REFERENCE", () => {
    const nodes = [createTaskGraphNode("task", { dependencies: ["missing"] })];

    expect(() => new TaskGraph(nodes)).toThrow(
      expect.objectContaining({
        code: "BROKEN_REFERENCE",
        details: { source: "task", target: "missing" },
      }),
    );
  });
});

describe("Декодирование графовой проекции", () => {
  test("проекция не требует доску, тексты и журнал полной карточки", () => {
    const node = taskGraphNode(projection);

    const progress = new TaskGraph([node]).progress("task");

    expect(progress).toEqual({ completed: true, canComplete: true, blockers: [] });
  });

  test.each(corruptedProjectionCases)("$name отклоняется как CORRUPT_DATA", ({ patch }) => {
    // Намеренно повреждаем только одно используемое поле валидной узкой проекции.
    const corruptedRecord = { ...projection, data: { ...projection.data, ...patch } };

    expect(() => taskGraphNode(corruptedRecord)).toThrow(
      expect.objectContaining({ code: "CORRUPT_DATA", details: { id: "task" } }),
    );
  });
});
