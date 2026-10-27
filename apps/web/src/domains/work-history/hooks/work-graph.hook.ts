import { useMemo } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import type { SWRResponse } from "swr";
import { WORK_HISTORY_GRAPH_CAPABILITY } from "../config/work-history.config";
import { getWorkGraphPage, getWorkGraphPoint } from "../adapters/work-graph.adapter";
import { mergeGraphPages } from "../helpers/merge-graph-pages";
import { useWorkRefresh } from "./use-work-refresh.hook";
import type {
  WorkGraphState,
  WorkGraphPointDetail,
  WorkHistoryGraphPage,
} from "../types/work-graph.type";

/**
 * Последовательно читает компактные страницы Core; ключи изолированы origin/project/scope.
 * После PAGE_CHANGED обновление начинается с первой страницы, не меняя выбранную точку.
 */
export function useWorkGraph(projectId: string, sessionId?: string): WorkGraphState {
  const pages = useSWRInfinite<WorkHistoryGraphPage, Error>(
    (index: number, previous: WorkHistoryGraphPage | null) => {
      if (previous?.nextOffset === null) {
        return null;
      }
      return [
        WORK_HISTORY_GRAPH_CAPABILITY,
        globalThis.location?.origin ?? "",
        projectId,
        sessionId,
        index === 0 ? 0 : previous?.nextOffset,
        previous?.version,
      ];
    },
    ([, , project, session, offset, version]: [
      string,
      string,
      string,
      string | undefined,
      number,
      string | undefined,
    ]) => getWorkGraphPage(project, offset, version, session),
    { revalidateAll: true, persistSize: false, shouldRetryOnError: false },
  );
  useWorkRefresh(projectId, pages.mutate);
  const merged = useMemo(() => mergeGraphPages(pages.data), [pages.data]);
  return {
    ...merged,
    isSupported: true,
    isLoading: pages.isLoading,
    isRefreshing: pages.isValidating,
    error: pages.error,
    refresh: () => {
      void pages
        .setSize(1)
        .then(() => pages.mutate())
        .catch(() => undefined);
    },
    loadMore: () => {
      if (merged.hasMore && !pages.isValidating && !pages.error) {
        void pages.setSize(pages.size + 1).catch(() => undefined);
      }
    },
  };
}

/**
 * Полный материал читается только при открытой точке; поздние ответы остаются в своём ключе.
 */
export function useWorkGraphPoint(
  projectId: string,
  ref: string,
): SWRResponse<WorkGraphPointDetail, Error> {
  const query = useSWR<WorkGraphPointDetail, Error>(
    ["work-history-point", globalThis.location?.origin ?? "", projectId, ref],
    () => getWorkGraphPoint(projectId, ref),
  );
  useWorkRefresh(projectId, query.mutate);
  return query;
}
