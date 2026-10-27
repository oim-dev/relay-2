/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { HistoryTimelinePage, HistoryTimelinePoint } from "@relay/contracts";
import { historyView } from "./history-view";
import { mergeGraphPages } from "../helpers/merge-graph-pages";

/**
 * Создаёт минимальный производный маркер из сохранённой границы, без мнимого материала.
 */
function point(id: string): HistoryTimelinePoint {
  return {
    id: `${id}:created`,
    sessionId: id,
    sequence: 1,
    at: "2026-10-26T10:00:00.000Z",
    title: id,
    summary: "",
    kind: "session-created",
    runId: null,
    runSessionId: null,
    predecessorRunId: null,
    checkpointId: null,
    checkpointKind: null,
    intentState: null,
  };
}

/**
 * Минимальная страница DTO для проверки преобразования и смешения поколений.
 */
function page(id: string, generation: number, nextOffset: number | null): HistoryTimelinePage {
  return {
    items: [point(id)],
    openEnds: [point(`old-${id}`)],
    totalOpenEnds: 2,
    branches: [],
    runs: [],
    edges: [],
    boundaryNodes: [],
    total: 2,
    nextOffset,
    generation,
  };
}

describe("Страницы Core в восстановленном renderer", () => {
  test("renderer получает разные ключи авторов при одинаковых scoped run ID", () => {
    const source = page("a", 1, null);
    source.items = [
      { ...point("a"), runId: "shared", runSessionId: "a" },
      { ...point("b"), runId: "shared", runSessionId: "b" },
    ];
    source.runs = ["a", "b"].map((sessionId) => ({
      id: "shared",
      key: "RUN-shared",
      sessionId,
      actor: `Агент ${sessionId}`,
      state: "active",
      operator: null,
      client: null,
      sourceSessionId: null,
      predecessorRunId: null,
      startedAt: "2026-10-26T10:00:00.000Z",
      endedAt: null,
    }));

    const view = historyView(source, 0);
    const byId = new Map(view.runs.map((run) => [run.id, run]));

    expect(byId.size).toBe(2);
    expect(view.items.map((point) => byId.get(point.runId ?? "")?.actor)).toEqual([
      "Агент a",
      "Агент b",
    ]);
    expect(view.runs.map((run) => run.rawId)).toEqual(["shared", "shared"]);
    expect(source.runs.map((run) => run.id)).toEqual(["shared", "shared"]);
  });
  test("разные поколения не смешиваются даже при старом кеше следующей страницы", () => {
    const first = historyView(page("new", 2, 1), 0);
    const old = historyView(page("old", 1, null), 1);

    const merged = mergeGraphPages([first, old]);

    expect(merged.graph?.items.map((point) => point.id)).toEqual(["new:created"]);
    expect(merged.graph?.version).toBe("2");
    expect(merged.hasMore).toBe(true);
  });

  test("незакрытые концы объединяются со всех страниц независимо от времени items", () => {
    const first = historyView(page("one", 3, 1), 0);
    const second = historyView(page("two", 3, null), 1);

    const merged = mergeGraphPages([first, second]);

    expect(merged.graph?.items.map((point) => point.id)).toEqual(["one:created", "two:created"]);
    expect(merged.graph?.openEnds.map((point) => point.id)).toEqual([
      "old-one:created",
      "old-two:created",
    ]);
    expect(merged.hasMore).toBe(false);
  });

  test("пропуск окна не выдаётся за непрерывное продолжение", () => {
    const merged = mergeGraphPages([
      historyView(page("one", 4, 1), 0),
      historyView(page("three", 4, null), 2),
    ]);

    expect(merged.graph?.items.map((point) => point.id)).toEqual(["one:created"]);
    expect(merged.hasMore).toBe(true);
  });
});
