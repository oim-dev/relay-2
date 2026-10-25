import { useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { relayClient } from "infra/relay-api";
import { useProject } from "../project-context";
import type { ProjectConnection } from "../types/project.types";
import { invalidateProjectPages } from "../operations/invalidation";

/**
 * Подключает один поток выбранного проекта. Connected после reconnect перечитывает
 * GET-кеш, но никогда не меняет черновики; Git-доставка определяется отдельным status.
 */
export function useProjectEvents(): ProjectConnection {
  const scope = useProject();
  const { mutate } = useSWRConfig();
  const [state, setState] = useState<ProjectConnection>("connecting");
  useEffect(
    () =>
      relayClient.subscribe(
        scope.projectId,
        (event) => {
          if (event.projectId !== scope.projectId) {
            return;
          }
          if (event.type === "storage-error") {
            setState("storage-error");
            return;
          }
          setState("connected");
          if (event.type === "connected" || event.type === "changed") {
            invalidateProjectPages(scope);
            void mutate(
              (key) =>
                Array.isArray(key) && key[0] === scope.serverKey && key[1] === scope.projectId,
            );
          }
        },
        () => setState("reconnecting"),
      ),
    [scope.projectId, scope.serverKey, mutate],
  );
  return state;
}
