import type { WorkGraph, WorkHistoryGraphPage } from "../types/work-graph.type";
import { getWorkGraphEdgeKey } from "./graph-edge-key";

/**
 * Склеивает только непрерывный префикс одного generation; старые страницы SWR не смешиваются.
 * OpenEnds тоже страничны: объединяются независимо от времени видимых items.
 */
export function mergeGraphPages(pages: readonly WorkHistoryGraphPage[] | undefined): {
  graph: WorkGraph | null;
  hasMore: boolean;
} {
  const first = pages?.[0];
  if (!first || first.offset !== 0) {
    return { graph: null, hasMore: false };
  }
  const points = new Map(first.items.map((point) => [point.id, point]));
  const branches = new Map(first.branches.map((branch) => [branch.id, branch]));
  const runs = new Map(first.runs.map((run) => [run.id, run]));
  const boundaries = new Map(first.boundaryNodes.map((node) => [node.id, node]));
  const openEnds = new Map(first.openEnds.map((point) => [point.id, point]));
  const edges = new Map(first.edges.map((edge) => [getWorkGraphEdgeKey(edge), edge]));
  let last = first;
  for (const page of pages?.slice(1) ?? []) {
    if (page.version !== first.version || page.offset !== last.nextOffset) {
      break;
    }
    for (const point of page.items) {
      points.set(point.id, point);
    }
    for (const point of page.openEnds) {
      openEnds.set(point.id, point);
    }
    for (const branch of page.branches) {
      branches.set(branch.id, branch);
    }
    for (const run of page.runs) {
      runs.set(run.id, run);
    }
    for (const node of page.boundaryNodes) {
      boundaries.set(node.id, node);
    }
    for (const edge of page.edges) {
      edges.set(getWorkGraphEdgeKey(edge), edge);
    }
    last = page;
  }
  for (const id of points.keys()) {
    boundaries.delete(id);
  }
  const visible = new Set([...points.values()].map((point) => point.sessionId));
  return {
    graph: {
      items: [...points.values()],
      openEnds: [...openEnds.values()],
      branches: [...branches.values()].map((branch) => ({
        ...branch,
        contextOnly: !visible.has(branch.id),
      })),
      runs: [...runs.values()],
      edges: [...edges.values()],
      boundaryNodes: [...boundaries.values()],
      total: first.total,
      version: first.version,
    },
    hasMore: last.nextOffset !== null,
  };
}
