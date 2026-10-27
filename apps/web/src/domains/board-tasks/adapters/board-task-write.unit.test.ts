/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { BatchResult, TaskRecord } from "@relay/contracts";
import { batchResponse, withAdapterHttp } from "domains/relay-data/testing/adapter-http";
import {
  changeTaskCriterion,
  linkBoardTask,
  moveBoardTask,
  publishTaskComment,
} from "./board-tasks.adapter";

const task: TaskRecord = {
  id: "task",
  kind: "task",
  key: "WORK-2",
  revision: 24,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:01:00.000Z",
  createdBy: "Автор сервера",
  updatedBy: "Автор сервера",
  data: {
    boardId: "board-target",
    title: "Задача",
    description: "Исходный текст",
    column: "review",
    parentId: null,
    dependencies: [],
    related: [],
    targets: [],
    acceptanceCriteria: [],
    comments: [],
  },
};

/**
 * Подготавливает квитанцию задачи с явным именем операции; guard запроса не вычисляется здесь.
 */
function taskReceipt(op: string): Omit<BatchResult, "operationKey"> {
  return {
    status: "committed",
    replayed: false,
    items: [
      {
        index: 0,
        op,
        as: null,
        id: "task",
        kind: "task",
        key: "WORK-2",
        revision: 24,
        owner: { id: "task", kind: "task", key: "WORK-2", revision: 24 },
        outputs: [],
      },
    ],
    entities: [structuredClone(task)],
  };
}

describe("Предметные payloads канбана", () => {
  test("перемещение сохраняет исходный CAS и ID новой доски без вычисленного rank или свежего GET", async () => {
    const result = await withAdapterHttp(
      (request) => batchResponse(request, taskReceipt("task.move")),
      () =>
        moveBoardTask("task-move", "task", {
          board: "board-target",
          column: "review",
          ifRevision: 23,
          requestId: "move",
        }),
    );

    expect(result.value).toEqual({
      id: "task",
      key: "WORK-2",
      revision: 24,
      boardId: "board-target",
      action: "task.move",
      requestId: "move",
    });
    expect(result.requests).toHaveLength(2);
    expect(await result.requests[1]?.json()).toEqual({
      actor: "Автор сервера",
      operationKey: "move",
      commands: [
        {
          op: "task.move",
          ref: "task",
          ifRevision: 23,
          input: { column: "review", board: "board-target" },
        },
      ],
    });
  });

  test("завершение критерия адресует вложенный ID под исходным CAS задачи-владельца", async () => {
    const receipt: Omit<BatchResult, "operationKey"> = {
      status: "committed",
      replayed: false,
      items: [
        {
          index: 0,
          op: "task.criterion.complete",
          as: null,
          id: "criterion",
          kind: "task-criterion",
          key: null,
          revision: 24,
          owner: { id: "task", kind: "task", key: "WORK-2", revision: 24 },
          outputs: [],
        },
      ],
      entities: [
        {
          ...structuredClone(task),
          data: {
            ...structuredClone(task.data),
            acceptanceCriteria: [
              {
                id: "criterion",
                title: "Проверить",
                summary: "",
                description: "",
                completed: true,
                completedAt: "2026-10-26T00:01:00.000Z",
                completedBy: "Автор сервера",
              },
            ],
          },
        },
      ],
    };

    const result = await withAdapterHttp(
      (request) => batchResponse(request, receipt),
      () =>
        changeTaskCriterion("task-criterion", "task", {
          action: "complete",
          criterionId: "criterion",
          completed: true,
          ifRevision: 23,
          requestId: "criterion-write",
        }),
    );

    expect(result.value).toEqual({
      id: "task",
      key: "WORK-2",
      revision: 24,
      boardId: "board-target",
      action: "task.criterion.complete",
      requestId: "criterion-write",
      criterionId: "criterion",
    });
    expect(await result.requests[1]?.json()).toEqual({
      actor: "Автор сервера",
      operationKey: "criterion-write",
      commands: [
        {
          op: "task.criterion.complete",
          ref: "task",
          ifRevision: 23,
          input: { id: "criterion" },
        },
      ],
    });
  });

  test("комментарий передаёт точный Markdown и автора контекста без CAS содержания", async () => {
    const receipt: Omit<BatchResult, "operationKey"> = {
      status: "committed",
      replayed: false,
      items: [
        {
          index: 0,
          op: "task.comment.add",
          as: null,
          id: "comment",
          kind: "task-comment",
          key: null,
          revision: 24,
          owner: { id: "task", kind: "task", key: "WORK-2", revision: 24 },
          outputs: [],
        },
      ],
      entities: [
        {
          ...structuredClone(task),
          data: {
            ...structuredClone(task.data),
            comments: [
              {
                id: "comment",
                title: "Наблюдение",
                body: "  **Точный текст**\n\n",
                createdAt: "2026-10-26T00:01:00.000Z",
                createdBy: "Автор сервера",
              },
            ],
          },
        },
      ],
    };

    const result = await withAdapterHttp(
      (request) => batchResponse(request, receipt),
      () =>
        publishTaskComment("task-comment", "task", {
          title: "Наблюдение",
          description: "  **Точный текст**\n\n",
          requestId: "comment-write",
        }),
    );

    expect(result.value).toEqual({
      id: "task",
      commentId: "comment",
      action: "comment-publish",
      revision: 24,
      requestId: "comment-write",
    });
    expect(await result.requests[1]?.json()).toEqual({
      actor: "Автор сервера",
      operationKey: "comment-write",
      commands: [
        {
          op: "task.comment.add",
          ref: "task",
          input: { title: "Наблюдение", body: "  **Точный текст**\n\n" },
        },
      ],
    });
  });

  test("снятие родителя не отправляет старый target и сохраняет guard самой задачи", async () => {
    const result = await withAdapterHttp(
      (request) => batchResponse(request, taskReceipt("task.parent.clear")),
      () =>
        linkBoardTask("task-parent", "task", {
          relation: "parent",
          remove: true,
          target: "old-parent",
          ifRevision: 23,
          requestId: "clear-parent",
        }),
    );

    expect(result.value.id).toBe("task");
    expect(await result.requests[1]?.json()).toEqual({
      actor: "Автор сервера",
      operationKey: "clear-parent",
      commands: [
        {
          op: "task.parent.clear",
          ref: "task",
          ifRevision: 23,
          input: {},
        },
      ],
    });
  });
});
