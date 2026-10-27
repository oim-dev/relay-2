import type {
  HistoryTimelinePage,
  HistoryTimelinePoint,
  HistoryTimelineEdge,
  HistoryTimelineBoundary,
} from "@relay/contracts";
import type { TimelineIndex } from "./history-timeline.types";
import type { ViewPageInput } from "../queries/view-page.types";
import { corruptTimeline, timelineRunKey } from "./history-timeline-index";

/**
 * Задаёт устойчивый обратный порядок, включая одинаковые timestamp.
 */
function descending(a: HistoryTimelinePoint, b: HistoryTimelinePoint): number {
  return (
    b.at.localeCompare(a.at) || b.sessionId.localeCompare(a.sessionId) || b.sequence - a.sequence
  );
}

/**
 * Отдаёт два bounded окна точек и незакрытых концов, сохраняя хронологические границы.
 * Metadata авторов/предков — только closure этих окон; тело соседних работ не читается.
 */
export function timelineWindow(
  index: TimelineIndex,
  page: ViewPageInput,
  generation: number,
  sessionId?: string,
): HistoryTimelinePage {
  const lines = [...index.lines].filter(([id]) => sessionId === undefined || id === sessionId);
  const all = lines.flatMap(([, line]) => line).sort(descending);
  const allOpen = lines
    .flatMap(([id, line]) => {
      const last = line.at(-1);
      return index.sessions.get(id)?.closedAt === null && last ? [last] : [];
    })
    .sort(descending);
  const items = all.slice(page.offset, page.offset + page.limit);
  const openEnds = allOpen.slice(page.offset, page.offset + page.limit);
  const visible = new Set(items.map((point) => point.id));
  const visibleEnds = new Set(openEnds.map((point) => point.id));
  const renderedSessions = new Set([...items, ...openEnds].map((point) => point.sessionId));
  const positions = new Map(all.map((point, position) => [point.id, position]));
  const boundary = new Map<string, HistoryTimelineBoundary>();
  const edges: HistoryTimelineEdge[] = [];
  for (const [session, line] of lines) {
    if (!renderedSessions.has(session)) {
      continue;
    }
    for (let i = 1; i < line.length; i++) {
      const from = line[i - 1];
      const to = line[i];
      if (!from || !to) {
        continue;
      }
      if (
        !visible.has(from.id) &&
        !visible.has(to.id) &&
        !visibleEnds.has(from.id) &&
        !visibleEnds.has(to.id)
      ) {
        continue;
      }
      edges.push({ kind: "sequence", from: from.id, to: to.id });
      for (const point of [from, to]) {
        if (!visible.has(point.id)) {
          boundary.set(point.id, {
            id: point.id,
            kind: point.kind,
            sessionId: point.sessionId,
            at: point.at,
            sequence: point.sequence,
            side: (positions.get(point.id) ?? 0) < page.offset ? "before" : "after",
          });
        }
      }
    }
  }
  for (const point of items) {
    const session = index.sessions.get(point.sessionId);
    if (!session) {
      corruptTimeline(point.id, "session");
    }
    const parent = session.parentSessionId;
    if (point.kind === "session-created") {
      edges.push(
        parent === null
          ? { kind: "root-start", from: null, to: point.id }
          : { kind: "fork", fromSessionId: parent, to: point.id },
      );
    }
    if (point.kind === "session-closed") {
      edges.push(
        parent === null
          ? { kind: "root-end", from: point.id, to: null }
          : { kind: "branch-end", from: point.id, toSessionId: parent },
      );
    }
  }
  const sessionIds = new Set(
    [...items, ...openEnds, ...boundary.values()].map((point) => point.sessionId),
  );
  const runIds = new Set<string>();
  for (const point of [...items, ...openEnds]) {
    const owner = point.runSessionId;
    if (owner === null) {
      if (point.runId !== null || point.predecessorRunId !== null) {
        corruptTimeline(point.id, "runSessionId");
      }
      continue;
    }
    sessionIds.add(owner);
    for (const id of [point.runId, point.predecessorRunId]) {
      if (id !== null) {
        runIds.add(timelineRunKey(owner, id));
      }
    }
  }
  // Итератор Set посещает добавленных предков; циклы уже отклонены при индексации.
  for (const id of sessionIds) {
    const parent = index.sessions.get(id)?.parentSessionId;
    if (parent != null) {
      sessionIds.add(parent);
    }
  }
  const branches = [...sessionIds].map((id) => {
    const session = index.sessions.get(id);
    if (!session) {
      corruptTimeline(id, "parent");
    }
    const { runs: _runs, ...header } = session;
    return header;
  });
  const runs = [...runIds].map((id) => {
    const run = index.runs.get(id);
    if (!run) {
      corruptTimeline(id, "run");
    }
    return run;
  });
  return {
    items,
    openEnds,
    totalOpenEnds: allOpen.length,
    branches,
    runs,
    edges,
    boundaryNodes: [...boundary.values()],
    total: all.length,
    nextOffset: page.offset + page.limit < all.length ? page.offset + page.limit : null,
    generation,
  };
}
