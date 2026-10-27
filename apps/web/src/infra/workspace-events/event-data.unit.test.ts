/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { readWorkspaceEvent } from "./event-data";

describe("Проверка SSE перед обновлением GET-кеша", () => {
  test.each([
    { name: "подключение и reconnect", type: "connected" as const },
    { name: "внешнее изменение", type: "changed" as const },
  ])("$name собственного проекта требуют перечитать подтверждённые данные", ({ type }) => {
    const signal = readWorkspaceEvent(
      "project-a",
      type,
      JSON.stringify({ type, projectId: "project-a", generation: 42 }),
    );

    expect(signal).toEqual({ state: "connected" });
  });

  test("событие другого проекта не инвалидирует текущий кеш", () => {
    const signal = readWorkspaceEvent(
      "project-a",
      "changed",
      JSON.stringify({ type: "changed", projectId: "project-b", generation: 42 }),
    );

    expect(signal).toBeNull();
  });

  test("серверный отказ сохраняет код и причину вместо ложного connected", () => {
    const signal = readWorkspaceEvent(
      "project-a",
      "storage-error",
      JSON.stringify({
        type: "storage-error",
        projectId: "project-a",
        generation: null,
        error: { code: "PROJECT_UNAVAILABLE", message: "Проект перепривязан" },
      }),
    );

    expect(signal).toEqual({
      state: "storage-error",
      code: "PROJECT_UNAVAILABLE",
      message: "Проект перепривязан",
    });
  });

  test("повреждённое поколение отклоняется вместо сигнала для обновления кеша", () => {
    const invalid = JSON.stringify({ type: "changed", projectId: "project-a", generation: -1 });

    expect(() => readWorkspaceEvent("project-a", "changed", invalid)).toThrow(ZodError);
  });

  test("несовпадающий discriminator события не принимается как connected", () => {
    const mismatched = JSON.stringify({ type: "changed", projectId: "project-a", generation: 1 });

    const signal = readWorkspaceEvent("project-a", "connected", mismatched);

    expect(signal).toBeNull();
  });
});
