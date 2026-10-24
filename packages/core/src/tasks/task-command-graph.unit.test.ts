import { describe, expect, test } from "bun:test";
import type { TaskRecord } from "@relay/contracts";
import { TaskGraphCache } from "./task-command-graph";

/**
 * Готовит одну полную карточку для проверки проекции графа без БД и случайных метаданных.
 */
function task(id: string, key: string, parentId: string | null = null): TaskRecord {
  return {
    id,
    key,
    kind: "task",
    revision: 1,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    createdBy: "author",
    updatedBy: "author",
    data: {
      boardId: "board",
      title: "",
      description: "",
      column: "ready",
      parentId,
      dependencies: [],
      related: [],
      targets: [],
      acceptanceCriteria: [],
      comments: [],
    },
  };
}

describe("Граф одного overlay-состояния команд", () => {
  test("порядок блокирующих детей сохраняет key/id, а не случайный порядок UUID", () => {
    const parent = task("parent", "TASK-1");
    const first = task("z-child", "TASK-2", parent.id);
    const second = task("a-child", "TASK-3", parent.id);
    const cache = new TaskGraphCache();

    const graph = cache.get([parent, first, second]);

    expect(graph.progress(parent.id).blockers).toEqual([first.id, second.id]);
    const renamed = { ...second, key: "TASK-0" };
    const next = cache.get([parent, first, renamed]);
    expect(next).not.toBe(graph);
    expect(next.progress(parent.id).blockers).toEqual([second.id, first.id]);
  });

  test("тот же кандидат после apply и неграфовая правка используют один расчёт", () => {
    const parent = task("parent", "TASK-1");
    const child = task("child", "TASK-2", parent.id);
    const cache = new TaskGraphCache();
    const graph = cache.get([parent], child);
    const changed = { ...child, revision: 2, data: { ...child.data, description: "Новый текст" } };

    const same = cache.get(structuredClone([changed, parent]));

    expect(same).toBe(graph);
    expect(same.progress(parent.id).blockers).toEqual([child.id]);
    expect(child.data.description).toBe("");
  });

  test("после изменения колонки либо отметки критерия кеш не возвращает старую готовность", () => {
    const parent = task("parent", "TASK-1");
    const child = task("child", "TASK-2", parent.id);
    const cache = new TaskGraphCache();
    const blocked = cache.get([parent, child]);
    const completed: TaskRecord = { ...child, data: { ...child.data, column: "done" } };

    const ready = cache.get([parent, child], completed);

    expect(ready).not.toBe(blocked);
    expect(ready.progress(parent.id)).toEqual({
      completed: false,
      canComplete: true,
      blockers: [],
    });
    const criterion = {
      id: "criterion",
      title: "Проверка",
      summary: "",
      description: "",
      completed: false,
      completedAt: null,
      completedBy: null,
    };
    const changed = { ...completed, data: { ...completed.data, acceptanceCriteria: [criterion] } };
    const afterCriterion = cache.get([parent, changed]);
    expect(afterCriterion).not.toBe(ready);
    expect(afterCriterion.progress(parent.id).blockers).toEqual([child.id]);
  });
});
