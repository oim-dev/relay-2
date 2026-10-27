import type {
  HistoryCheckpoint,
  HistoryRun,
  HistorySession,
  HistoryTimelinePage,
} from "@relay/contracts";
import type { WorkGraphPoint, WorkHistoryGraphPage } from "../types/work-graph.type";
import { historyMessages } from "../config/history.messages";

/**
 * Адаптирует один компактный DTO без пересчёта хронологии, intent-состояний или родства.
 */
export function historyView(page: HistoryTimelinePage, offset: number): WorkHistoryGraphPage {
  const visible = new Set(page.items.map((point) => point.sessionId));
  return {
    ...page,
    items: page.items.map(graphPoint),
    openEnds: page.openEnds.map(graphPoint),
    runs: page.runs.map((run) => ({ ...run, id: runKey(run.sessionId, run.id), rawId: run.id })),
    offset,
    version: String(page.generation),
    branches: page.branches.map((branch) => ({
      ...branch,
      parentSequence: null,
      contextOnly: !visible.has(branch.id),
    })),
  };
}

/**
 * Scoped ключ таблицы автора; одинаковые native ID разных владельцев не смешиваются.
 */
function runKey(sessionId: string, runId: string): string {
  return JSON.stringify([sessionId, runId]);
}

/**
 * Адаптирует только адреса авторов для существующего renderer с единственной Map по id.
 */
function graphPoint(point: HistoryTimelinePage["items"][number]): WorkGraphPoint {
  if (point.kind === "checkpoint") {
    return {
      ...point,
      runId: runKey(point.runSessionId, point.runId),
      predecessorRunId:
        point.predecessorRunId === null ? null : runKey(point.runSessionId, point.predecessorRunId),
    };
  }
  const owner = point.runSessionId;
  if (owner === null) {
    if (point.runId !== null || point.predecessorRunId !== null) {
      throw new Error(historyMessages.missingAuthor);
    }
    return point;
  }
  return {
    ...point,
    runId: point.runId === null ? null : runKey(owner, point.runId),
    predecessorRunId:
      point.predecessorRunId === null ? null : runKey(owner, point.predecessorRunId),
  };
}

/**
 * Представляет адресно прочитанный материал; состояние intent остаётся у timeline Core.
 */
export function checkpointPoint(checkpoint: HistoryCheckpoint, run: HistoryRun): WorkGraphPoint {
  return {
    id: `${checkpoint.id}:checkpoint`,
    sessionId: checkpoint.data.sessionId,
    sequence: checkpoint.data.sequence,
    at: checkpoint.createdAt,
    kind: "checkpoint",
    title: checkpoint.data.title,
    summary: checkpoint.data.summary ?? "",
    runId: run.id,
    runSessionId: checkpoint.data.sessionId,
    predecessorRunId: run.predecessorRunId,
    checkpointId: checkpoint.id,
    checkpointKind: checkpoint.data.kind,
    intentState: null,
  };
}

/**
 * Раскрывает адрес выбранной lifecycle-границы из сохранённых полей, без поиска всех событий.
 */
export function lifecycleDetailPoint(
  session: HistorySession,
  ref: string,
  runs: ReadonlyMap<string, HistoryRun>,
): WorkGraphPoint | undefined {
  let kind: Exclude<WorkGraphPoint["kind"], "checkpoint">;
  let run: HistoryRun | null;
  let at: string | null;
  if (ref === `${session.id}:created`) {
    kind = "session-created";
    at = session.createdAt;
    run =
      session.data.parentSessionId === null
        ? (session.data.runs[0] ?? null)
        : (runs.get(session.data.createdByRunId ?? "") ?? null);
  } else if (ref === `${session.id}:closed`) {
    kind = "session-closed";
    at = session.data.closedAt;
    run = session.data.runs.findLast((run) => run.endedAt === at) ?? null;
  } else {
    const selected = session.data.runs.find(
      (run) => ref === `${session.id}~${run.id}:started` || ref === `${session.id}~${run.id}:ended`,
    );
    if (!selected) {
      return undefined;
    }
    run = selected;
    kind = ref.endsWith(":started") ? "run-started" : "run-ended";
    at = kind === "run-started" ? run.startedAt : run.endedAt;
  }
  if (at === null) {
    return undefined;
  }
  let runSessionId: string | null = null;
  if (run !== null) {
    runSessionId =
      kind === "session-created" ? (session.data.parentSessionId ?? session.id) : session.id;
  }
  return {
    id: ref,
    sessionId: session.id,
    sequence: 1,
    at,
    kind,
    title: session.data.title,
    summary: "",
    runId: run?.id ?? null,
    runSessionId,
    predecessorRunId: run?.predecessorRunId ?? null,
    checkpointId: null,
    checkpointKind: null,
    intentState: null,
  };
}
