import {
  RelayError,
  type HistoryTimelinePoint,
  type HistoryTimelineRun,
  type HistoryTimelineSession,
  type HistoryTimelineCheckpoint,
} from "@relay/contracts";
import type { TimelineIndex } from "./history-timeline.types";
import { timelineMessages } from "./history-timeline.messages";
import { historyIntentOutcome } from "./history-rules";

/**
 * Сохраняет точный адрес повреждённого источника вместо пустой истории.
 */
export function corruptTimeline(id: string, field: string): never {
  throw new RelayError("CORRUPT_DATA", timelineMessages.corrupt, 1, { id, field });
}

/**
 * Адресует scoped участие без предположения глобальной уникальности native ID части.
 */
export function timelineRunKey(sessionId: string, runId: string): string {
  return JSON.stringify([sessionId, runId]);
}

/**
 * Представляет реально сохранённую временную границу; новых событий и времени now нет.
 */
function lifecycle(
  session: HistoryTimelineSession,
  kind: Exclude<HistoryTimelinePoint["kind"], "checkpoint">,
  at: string,
  run: HistoryTimelineRun | null,
): HistoryTimelinePoint {
  const suffix = {
    "session-created": "created",
    "session-closed": "closed",
    "run-started": "started",
    "run-ended": "ended",
  }[kind];
  const owner = kind.startsWith("run-") && run ? `${session.id}~${run.id}` : session.id;
  return {
    id: `${owner}:${suffix}`,
    sessionId: session.id,
    sequence: 0,
    at,
    kind,
    title: session.title,
    summary: "",
    runId: run?.id ?? null,
    runSessionId: run?.sessionId ?? null,
    predecessorRunId: run?.predecessorRunId ?? null,
    checkpointId: null,
    checkpointKind: null,
    intentState: null,
  };
}

/**
 * Проверяет происхождение и ацикличность родителей за O(S), включая невидимые предки.
 */
function validateParents(
  index: TimelineIndex,
  checkpoints: ReadonlyMap<string, HistoryTimelineCheckpoint>,
): void {
  const checked = new Set<string>();
  for (const session of index.sessions.values()) {
    if (session.parentSessionId !== null) {
      const origin = checkpoints.get(session.originCheckpointId ?? "");
      if (
        !index.sessions.has(session.parentSessionId) ||
        origin?.kind !== "intent" ||
        origin.sessionId !== session.parentSessionId ||
        !index.runs.has(timelineRunKey(session.parentSessionId, session.createdByRunId ?? ""))
      ) {
        corruptTimeline(session.id, "origin");
      }
    }
    let current: HistoryTimelineSession | undefined = session;
    const path = new Set<string>();
    while (current && !checked.has(current.id)) {
      if (path.has(current.id)) {
        corruptTimeline(current.id, "parentCycle");
      }
      path.add(current.id);
      current = index.sessions.get(current.parentSessionId ?? "");
    }
    for (const id of path) {
      checked.add(id);
    }
  }
}

/**
 * Индексирует всю узкую metadata один раз. Материалы проверяются до фильтра сессии,
 * terminal intent вычисляется по полному набору, а не по видимой странице.
 */
export function timelineIndex(
  sessions: readonly HistoryTimelineSession[],
  checkpoints: readonly HistoryTimelineCheckpoint[],
): TimelineIndex {
  const index: TimelineIndex = {
    sessions: new Map(sessions.map((session) => [session.id, session])),
    runs: new Map(),
    lines: new Map(),
  };
  for (const session of sessions) {
    for (const run of session.runs) {
      const key = timelineRunKey(session.id, run.id);
      if (index.runs.has(key)) {
        corruptTimeline(run.id, "duplicateRun");
      }
      index.runs.set(key, run);
    }
  }
  const byId = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  validateParents(index, byId);
  const outcomes = new Map<string, "completed" | "cancelled">();
  const byRun = new Map<string, HistoryTimelineCheckpoint[]>();
  const sequences = new Set<string>();
  for (const checkpoint of checkpoints) {
    const runKey = timelineRunKey(checkpoint.sessionId, checkpoint.runId);
    if (
      !index.sessions.has(checkpoint.sessionId) ||
      index.runs.get(runKey)?.actor !== checkpoint.actor
    ) {
      corruptTimeline(checkpoint.id, "session/run/actor");
    }
    const sequence = JSON.stringify([checkpoint.sessionId, checkpoint.sequence]);
    if (sequences.has(sequence)) {
      corruptTimeline(checkpoint.id, "sequence");
    }
    sequences.add(sequence);
    const owner = index.sessions.get(checkpoint.sessionId);
    if (!owner || checkpoint.sessionRevision > owner.revision) {
      corruptTimeline(checkpoint.id, "sessionRevision");
    }
    const runMaterials = byRun.get(runKey) ?? [];
    runMaterials.push(checkpoint);
    byRun.set(runKey, runMaterials);
    if (checkpoint.intentId !== null) {
      const intent = byId.get(checkpoint.intentId);
      if (intent?.kind !== "intent" || intent.sessionId !== checkpoint.sessionId) {
        corruptTimeline(checkpoint.id, "intentId");
      }
      const outcome = historyIntentOutcome(checkpoint.kind);
      if (outcome !== null) {
        if (outcomes.has(checkpoint.intentId)) {
          corruptTimeline(checkpoint.id, "duplicateTerminal");
        }
        outcomes.set(checkpoint.intentId, outcome);
      }
    }
  }
  for (const session of sessions) {
    const creator =
      session.parentSessionId === null
        ? (session.runs[0] ?? null)
        : (index.runs.get(timelineRunKey(session.parentSessionId, session.createdByRunId ?? "")) ??
          null);
    const points = [lifecycle(session, "session-created", session.createdAt, creator)];
    let lastSequence = 0;
    for (const run of session.runs) {
      // Совпадающие создание/подключение и закрытие/окончание представлены одним маркером.
      if (
        run.id !== creator?.id ||
        run.sessionId !== creator?.sessionId ||
        run.startedAt !== session.createdAt
      ) {
        points.push(lifecycle(session, "run-started", run.startedAt, run));
      }
      for (const checkpoint of (byRun.get(timelineRunKey(session.id, run.id)) ?? []).sort(
        (a, b) => a.sequence - b.sequence,
      )) {
        if (checkpoint.sequence <= lastSequence) {
          corruptTimeline(checkpoint.id, "sequence/run");
        }
        lastSequence = checkpoint.sequence;
        points.push({
          id: `${checkpoint.id}:checkpoint`,
          sessionId: checkpoint.sessionId,
          sequence: checkpoint.sequence,
          at: checkpoint.createdAt,
          kind: "checkpoint",
          title: checkpoint.title,
          summary: checkpoint.summary ?? "",
          runId: run.id,
          runSessionId: session.id,
          predecessorRunId: run.predecessorRunId,
          checkpointId: checkpoint.id,
          checkpointKind: checkpoint.kind,
          intentState:
            checkpoint.kind === "intent" ? (outcomes.get(checkpoint.id) ?? "open") : null,
        });
      }
      if (run.endedAt !== null && run.endedAt !== session.closedAt) {
        points.push(lifecycle(session, "run-ended", run.endedAt, run));
      }
    }
    if (session.closedAt !== null) {
      points.push(
        lifecycle(
          session,
          "session-closed",
          session.closedAt,
          session.runs.findLast((run) => run.endedAt === session.closedAt) ?? null,
        ),
      );
    }
    // Последовательность участия и sequence материалов причинны даже при переводе часов назад.
    index.lines.set(
      session.id,
      points.map((point, ordinal) => ({ ...point, sequence: ordinal + 1 })),
    );
  }
  return index;
}
