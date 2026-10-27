import { useEffect } from "react";
import useSWR from "swr";
import type { SWRResponse } from "swr";
import { subscribeWorkspace } from "infra/workspace-events";
import { getRelationDiagram } from "../adapters/relation-diagram.adapter";
import type { RelationDiagram, RelationDiagramRequest } from "../types/relation-diagram.type";

/**
 * Хранит только согласованные снимки; при ошибке продолжения оставляет прежний граф доступным.
 */
export const useRelationDiagram = (
  projectId: string,
  request: RelationDiagramRequest,
  refreshKey: number,
): SWRResponse<RelationDiagram, Error> => {
  const response = useSWR<RelationDiagram, Error>(
    ["relation-diagram", globalThis.location?.origin ?? "", projectId, request, refreshKey],
    () => getRelationDiagram(projectId, request),
    { keepPreviousData: true, shouldRetryOnError: false, revalidateOnFocus: false },
  );
  const { mutate } = response;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected") {
          void mutate().catch(() => undefined);
        }
      }),
    [projectId, mutate],
  );
  return response;
};
