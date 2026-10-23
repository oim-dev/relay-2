import { describe, expect, test } from "bun:test";
import { renderResult } from "./output";

const overview = {
  project: {
    kind: "project",
    key: "PROJECT",
    revision: 1,
    id: "project-id",
    createdAt: "2026-10-23T09:00:00Z",
    createdBy: "system",
    data: { name: "Аудит  CLI", slug: "audit" },
  },
  generation: 25,
  counts: {
    project: 1,
    product: 1,
    feature: 1,
    scenario: 1,
    application: 1,
    implementation: 1,
    board: 2,
    document: 2,
    task: 6,
    "work-plan": 1,
    release: 1,
    "work-session": 1,
    "work-checkpoint": 1,
  },
  tasks: {
    total: 6,
    columns: { inbox: 1, ready: 1, "in-progress": 1, review: 1, done: 1, cancelled: 1 },
    blocked: 2,
  },
};
const summary =
  "Сводка проекта\nPROJECT · Аудит  CLI · ревизия 1 · поколение 25\nЗаписей: 20\n" +
  "Проекты 1 · Продукты 1 · Фичи 1 · Сценарии 1\n" +
  "Приложения 1 · Реализации 1 · Доски 2 · Документы 2\n" +
  "Задачи 6 · Планы 1 · Релизы 1 · Сессии 1 · Контрольные точки 1\n" +
  "Задачи (6): inbox 1 · ready 1 · in-progress 1 · review 1 · done 1 · cancelled 1\n" +
  "С незавершёнными прямыми обязательствами: 2";

describe("Компактная сводка проекта", () => {
  test("глобальные счётчики отделены от страницы карты и полного продолжения", () => {
    const result = {
      data: {
        ...overview,
        items: [
          { kind: "application", key: "APP-1", revision: 3, data: { name: "Клиент 🧪" } },
          {
            kind: "task",
            key: "CLI-1",
            revision: 1,
            data: { title: "Готовая задача", column: "done" },
          },
        ],
      },
      meta: {
        page: {
          count: 2,
          total: 20,
          limit: 2,
          nextCursor: "next",
          nextCommand: "relay overview --limit=2 --cursor=next",
          consistency: "snapshot" as const,
        },
      },
    };

    const rendered = renderResult(result, "text", "overview");

    expect(rendered).toBe(
      summary +
        "\n\nКарта — 2 из 20\n" +
        "APP-1 [application] · Клиент 🧪 · ревизия 3\n" +
        "CLI-1 [task] · Готовая задача · ревизия 1 · done\n\n" +
        "Продолжение: relay overview --limit=2 --cursor=next",
    );
    expect(JSON.parse(renderResult(result, "json", "overview"))).toEqual({ ok: true, ...result });
  });

  test("пустое окно сохраняет глобальные числа и не дублирует шапку DTO", () => {
    const rendered = renderResult(
      {
        data: { ...overview, items: [] },
        meta: {
          page: {
            count: 0,
            total: 20,
            limit: 2,
            nextCursor: null,
            nextCommand: null,
            consistency: "snapshot",
          },
        },
      },
      "text",
      "overview",
    );

    expect(rendered).toBe(summary + "\n\nКарта — 0 из 20\nЗаписей нет.");
  });
});
