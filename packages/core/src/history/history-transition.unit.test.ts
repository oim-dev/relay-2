import { describe, expect, test } from "bun:test";
import { RelayError, type HistoryCheckpoint, type HistorySession } from "@relay/contracts";
import { historyCheckpointInput, historyStartInput, historyTransitionInput } from "./history-input";
import {
  calculateHistoryCheckpoint,
  calculateHistoryStart,
  calculateHistoryTransition,
} from "./history-command-calculate";
import type { HistoryCommandState } from "./history-command.types";
import { assertHistoryTransition } from "./history-transition";
import type { HistoryTransitionContext } from "./history-transition.types";

const now = "2026-10-24T00:00:00.000Z";

/**
 * Создаёт независимый декодируемый корень без I/O, часов и случайных ID.
 */
function rootSession(): HistorySession {
  return calculateHistoryStart(
    historyStartInput({ title: "Проверка перехода" }),
    { id: "session", actor: "автор", now },
    "run",
  ).result;
}

/**
 * Собирает пустой предметный контекст вокруг явно выбранного владельца.
 */
function state(session: HistorySession): HistoryCommandState {
  return {
    session,
    intent: null,
    sessions: [session],
    checkpoints: [],
    references: { records: [], projectId: "project", project: null },
  };
}

/**
 * Формирует границу одного шага без обращения к executor или хранилищу.
 */
function context(
  previous: HistorySession,
  next: HistorySession,
  operation: string,
  checkpoints: readonly HistoryCheckpoint[] = [],
): HistoryTransitionContext {
  return {
    actor: "автор",
    operation,
    ...(next.data.currentRunId === null ? {} : { newRunId: next.data.currentRunId }),
    beforeSessions: [previous],
    afterSessions: [next],
    beforeCheckpoints: [],
    afterCheckpoints: checkpoints,
  };
}

/**
 * Требует предметный отказ, не принимая постороннее исключение за успешную защиту инварианта.
 */
function expectTransitionConflict(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ code: "CONFLICT" });
    return;
  }
  throw new Error("Ожидался конфликт перехода истории");
}

describe("Чистый переход истории", () => {
  test("расчёт паузы не меняет вход и сохраняет исходный before-effect", () => {
    const before = rootSession();
    const snapshot = structuredClone(before);
    const delta = calculateHistoryTransition(
      state(before),
      historyTransitionInput("pause", { runId: "run", reason: "Ожидание" }),
      { actor: "автор", ifRevision: 1 },
      { id: null, actor: "автор", now },
    );

    expect(before).toEqual(snapshot);
    expect(delta.result.data.status).toBe("paused");
    expect(delta.result.revision).toBe(2);
    expect(delta.result.data.runs[0]?.state).toBe("paused");
    expect(delta.effects).toEqual([{ kind: "entity", before: snapshot, after: delta.result }]);
  });

  test("пауза чужим автором запрещена даже для структурно допустимого результата", () => {
    const before = rootSession();
    const delta = calculateHistoryTransition(
      state(before),
      historyTransitionInput("pause", { runId: "run", reason: "Ожидание" }),
      { actor: "автор", ifRevision: 1 },
      { id: null, actor: "автор", now },
    );
    const forged = { ...delta.result, updatedBy: "чужой" };

    expectTransitionConflict(() =>
      assertHistoryTransition(before, forged, {
        ...context(before, forged, "session.pause"),
        actor: "чужой",
      }),
    );
  });

  test("смена имени или автора прежнего run не допускается при takeover", () => {
    const before = rootSession();
    const delta = calculateHistoryTransition(
      state(before),
      historyTransitionInput("takeover", { reason: "Передача" }),
      { actor: "автор", ifRevision: 1 },
      { id: "second-run", actor: "автор", now },
    );
    const forged = structuredClone(delta.result);
    const run = forged.data.runs[0];
    if (run === undefined) {
      throw new Error("Отсутствует исходное участие");
    }
    run.actor = "подмена";

    expectTransitionConflict(() =>
      assertHistoryTransition(before, forged, context(before, forged, "session.takeover")),
    );
  });

  test("завершённый run неизменяем при resume", () => {
    const before = rootSession();
    const paused = calculateHistoryTransition(
      state(before),
      historyTransitionInput("pause", { runId: "run", reason: "Ожидание" }),
      { actor: "автор", ifRevision: 1 },
      { id: null, actor: "автор", now },
    ).result;
    const resumed = calculateHistoryTransition(
      state(paused),
      historyTransitionInput("resume", {}),
      { actor: "автор", ifRevision: 2 },
      { id: "next-run", actor: "автор", now },
    ).result;
    const first = resumed.data.runs[0];
    if (first === undefined) {
      throw new Error("Отсутствует прежнее участие");
    }
    first.endReason = "Переписанная история";

    expectTransitionConflict(() =>
      assertHistoryTransition(paused, resumed, context(paused, resumed, "session.resume")),
    );
  });

  test.each([undefined, "run"])(
    "resume с ролью нового run %s отклоняет даже допустимую цепочку",
    (newRunId) => {
      const before = rootSession();
      const paused = calculateHistoryTransition(
        state(before),
        historyTransitionInput("pause", { runId: "run", reason: "Ожидание" }),
        { actor: "автор", ifRevision: 1 },
        { id: null, actor: "автор", now },
      ).result;
      const resumed = calculateHistoryTransition(
        state(paused),
        historyTransitionInput("resume", {}),
        { actor: "автор", ifRevision: 2 },
        { id: "next-run", actor: "автор", now },
      ).result;
      const { newRunId: _correct, ...boundary } = context(paused, resumed, "session.resume");

      expectTransitionConflict(() =>
        assertHistoryTransition(paused, resumed, {
          ...boundary,
          ...(newRunId === undefined ? {} : { newRunId }),
        }),
      );
      expect(paused.data.runs.map((run) => run.id)).toEqual(["run"]);
      expect(resumed.data.currentRunId).toBe("next-run");
    },
  );

  test("закрытая сессия не переоткрывается при переносе", () => {
    const before = rootSession();
    const closed = calculateHistoryTransition(
      state(before),
      historyTransitionInput("complete", { runId: "run", result: "Готово" }),
      { actor: "автор", ifRevision: 1 },
      { id: null, actor: "автор", now },
    ).result;

    expectTransitionConflict(() =>
      assertHistoryTransition(closed, before, context(closed, before, "session.resume")),
    );
  });

  test("source sessionRevision не сравнивается с целевым local CAS", () => {
    const before = rootSession();
    const delta = calculateHistoryCheckpoint(
      state(before),
      "open",
      historyCheckpointInput("open", { runId: "run", title: "Намерение", body: "Основание" }),
      { actor: "автор", ifRevision: 1 },
      { id: "checkpoint", actor: "автор", now },
    );
    const localBefore = { ...before, revision: 101 };
    const localAfter = { ...delta.owner, revision: 102 };

    expect(() =>
      assertHistoryTransition(
        null,
        delta.result,
        context(localBefore, localAfter, "checkpoint.open", [delta.result]),
      ),
    ).not.toThrow();
    expect(delta.result.data.sessionRevision).toBe(2);
  });

  test("переписывание checkpoint запрещено независимо от новой local revision", () => {
    const before = rootSession();
    const delta = calculateHistoryCheckpoint(
      state(before),
      "open",
      historyCheckpointInput("open", { runId: "run", title: "Намерение", body: "Основание" }),
      { actor: "автор", ifRevision: 1 },
      { id: "checkpoint", actor: "автор", now },
    );
    const forged = { ...delta.result, data: { ...delta.result.data, body: "Подмена" } };

    expectTransitionConflict(() =>
      assertHistoryTransition(
        delta.result,
        forged,
        context(before, delta.owner, "checkpoint.open"),
      ),
    );
  });

  test("legacy inference принимает доказанную паузу и отвергает её под видом resume", () => {
    const before = rootSession();
    const paused = calculateHistoryTransition(
      state(before),
      historyTransitionInput("pause", { runId: "run", reason: "Ожидание" }),
      { actor: "автор", ifRevision: 1 },
      { id: null, actor: "автор", now },
    ).result;

    expect(() =>
      assertHistoryTransition(before, paused, context(before, paused, "replication")),
    ).not.toThrow();
    expectTransitionConflict(() =>
      assertHistoryTransition(before, paused, context(before, paused, "session.resume")),
    );
  });
});
