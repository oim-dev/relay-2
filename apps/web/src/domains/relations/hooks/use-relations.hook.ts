import { useEffect } from "react";
import useSWR from "swr";
import type { SWRResponse } from "swr";
import { subscribeWorkspace } from "infra/workspace-events";
import { getRelations, getEntityContext } from "../adapters/relations.adapter";
import type { RelationsPage, RelationsQuery, EntityContext } from "../types/relations.type";

/**
 * Изолирует граф по проекту и фильтрам, обновляет после локальных и HTTP-изменений.
 */
export const useRelations = (
  projectId: string,
  query: RelationsQuery | null,
): SWRResponse<RelationsPage, Error> => {
  const response = useSWR<RelationsPage, Error>(
    query === null ? null : ["relations", globalThis.location?.origin ?? "", projectId, query],
    () => getRelations(projectId, query ?? {}),
    { shouldRetryOnError: false },
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

/**
 * Обновляет полный контекст выбранной сущности после SSE и восстановления соединения.
 */
export const useEntityContext = (
  projectId: string,
  root: string | null,
): SWRResponse<EntityContext, Error> => {
  const response = useSWR<EntityContext, Error>(
    root === null ? null : ["entity-context", globalThis.location?.origin ?? "", projectId, root],
    () => getEntityContext(projectId, root ?? ""),
    { shouldRetryOnError: false },
  );
  const { mutate } = response;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected" && root !== null) {
          void mutate().catch(() => undefined);
        }
      }),
    [projectId, root, mutate],
  );
  return response;
};
