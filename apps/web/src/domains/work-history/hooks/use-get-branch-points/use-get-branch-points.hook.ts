import { useWorkGraph } from "../work-graph.hook";
import { getWorkPointPresentation } from "../../helpers/point-presentation";
import type { BranchPointsState } from "../../types/branch-points.type";

/**
 * Навигация по одной сессии использует тот же bounded reader, без полного project snapshot.
 */
export function useGetBranchPoints(projectId: string, sessionId: string): BranchPointsState {
  const query = useWorkGraph(projectId, sessionId);
  const branch = query.graph?.branches.find((branch) => branch.id === sessionId);
  const runs = new Map(query.graph?.runs.map((run) => [run.id, run]));
  return {
    items:
      branch === undefined
        ? []
        : (query.graph?.items ?? []).map((point) => ({
            id: point.id,
            title: point.title,
            summary: point.summary,
            at: point.at,
            label: getWorkPointPresentation(point, runs.get(point.runId ?? "") ?? null, branch)
              .label,
          })),
    total: query.graph?.total ?? null,
    hasMore: query.hasMore,
    isLoading: query.isLoading,
    isRefreshing: query.isRefreshing,
    error: query.error,
    refresh: query.refresh,
    loadMore: query.loadMore,
  };
}
