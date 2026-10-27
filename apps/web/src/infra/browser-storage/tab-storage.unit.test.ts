/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { createTabStorage } from "./tab-storage";

describe("Черновики в памяти вкладки", () => {
  test("возврат к проекту восстанавливает исходный guard, но другой origin не видит этот draft", () => {
    let origin = "https://first.test";
    const storage = createTabStorage(() => origin);
    storage.write("task:project-a:task-1", { body: "Черновик A", revision: 7 });
    storage.write("task:project-b:task-1", { body: "Черновик B", revision: 4 });

    origin = "https://second.test";
    const otherOrigin = storage.read("task:project-a:task-1");
    storage.write("task:project-a:task-1", { body: "Другой сервер", revision: 20 });
    storage.remove("task:project-a:task-1");
    origin = "https://first.test";

    expect(otherOrigin).toEqual({ value: undefined, error: null });
    expect(storage.read("task:project-a:task-1")).toEqual({
      value: { body: "Черновик A", revision: 7 },
      error: null,
    });
    expect(storage.read("task:project-b:task-1")).toEqual({
      value: { body: "Черновик B", revision: 4 },
      error: null,
    });
  });

  test("снимки не разделяют изменяемый ввод и не возрождаются в новой вкладке или после reload", () => {
    const storage = createTabStorage(() => "https://relay.test");
    const initial = { body: "Сохранённый ввод", revision: 3 };

    expect(storage.write("project:form", initial)).toBe(true);
    initial.body = "Поздняя мутация";
    initial.revision = 9;
    const draft = storage.read("project:form");
    const otherTab = createTabStorage(() => "https://relay.test");

    expect(draft).toEqual({ value: { body: "Сохранённый ввод", revision: 3 }, error: null });
    expect(otherTab.read("project:form")).toEqual({ value: undefined, error: null });
    expect(storage.read("project:form").value).not.toBe(draft.value);
  });

  test("несериализуемая замена не уничтожает прежний черновик", () => {
    const storage = createTabStorage();
    storage.write("project:form", { body: "До ошибки", revision: 2 });

    const stored = storage.write("project:form", { invalid: 1n });

    expect(stored).toBe(false);
    expect(storage.read("project:form")).toEqual({
      value: { body: "До ошибки", revision: 2 },
      error: null,
    });
  });
});
