import { describe, expect, test } from "bun:test";
import { taskGraphNode } from "./task-data";
import { TaskGraph, type TaskGraphNode } from "./task-graph";

function node(id: string, fields: Partial<Omit<TaskGraphNode, "id">> = {}): TaskGraphNode {
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
  test("смешанные обязательства транзитивны, общий ребёнок-зависимость даёт один блокер", () => {
    const graph = new TaskGraph([
      node("root", { dependencies: ["middle"] }),
      node("middle", { dependencies: ["leaf"] }),
      node("leaf", { parentId: "middle", acceptanceCriteria: [{ completed: false }] }),
      node("cancelled", { column: "cancelled" }),
      node("ready", { column: "ready" }),
    ]);

    expect(graph.progress("root")).toEqual({
      completed: false,
      canComplete: false,
      blockers: ["middle"],
    });
    expect(graph.progress("middle")).toEqual({
      completed: false,
      canComplete: false,
      blockers: ["leaf"],
    });
    expect(graph.progress("leaf")).toEqual({ completed: false, canComplete: false, blockers: [] });
    expect(graph.progress("cancelled")).toEqual({
      completed: false,
      canComplete: true,
      blockers: [],
    });
    expect(graph.progress("ready")).toEqual({ completed: false, canComplete: true, blockers: [] });
  });

  test("смешанный цикл и отсутствующее обязательство отвергаются предметными ошибками", () => {
    expect(
      () =>
        new TaskGraph([
          node("parent"),
          node("child", { parentId: "parent", dependencies: ["parent"] }),
        ]),
    ).toThrow(expect.objectContaining({ code: "TASK_CYCLE" }));
    expect(() => new TaskGraph([node("orphan", { parentId: "missing" })])).toThrow(
      expect.objectContaining({ code: "BROKEN_REFERENCE" }),
    );
  });

  test("графовая проекция не требует доску, тексты и журнал, но проверяет используемые поля", () => {
    const projection = {
      id: "task",
      key: "PRODUCT-1",
      data: {
        column: "done",
        parentId: null,
        dependencies: [],
        acceptanceCriteria: [{ completed: true }],
      },
    };
    expect(new TaskGraph([taskGraphNode(projection)]).progress("task")).toEqual({
      completed: true,
      canComplete: true,
      blockers: [],
    });
    for (const patch of [
      { column: "other" },
      { dependencies: null },
      { dependencies: [null] },
      { parentId: false },
      { acceptanceCriteria: [{ completed: 1 }] },
    ]) {
      expect(() =>
        taskGraphNode({ ...projection, data: { ...projection.data, ...patch } }),
      ).toThrow(expect.objectContaining({ code: "CORRUPT_DATA" }));
    }
  });
});
