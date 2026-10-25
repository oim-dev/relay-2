import useSWR, { type SWRResponse } from "swr";
import type {
  EntityKind,
  HttpEntityPage,
  HttpReadParameters,
  HttpReadResults,
  HttpOverview,
  ServerContext,
} from "@relay/contracts";
import { relayClient, serverKey } from "infra/relay-api";
import { useProject } from "../project-context";
import type { VersionedEntity } from "../types/project.types";
import { projectDataMessages } from "../project.messages";

/**
 * Читает реестр вместе с недоступными регистрациями.
 */
export function useWorkspace(): SWRResponse<ServerContext> {
  return useSWR([serverKey, "context"], async () => (await relayClient.context()).data);
}

/**
 * Читает карточку и guard того же anchor; смена адреса не оставляет старые данные.
 */
export function useEntity(ref: string | undefined): SWRResponse<VersionedEntity> {
  const scope = useProject();
  return useSWR(ref ? [scope.serverKey, scope.projectId, "entity", ref] : null, async () => {
    if (!ref) {
      throw new Error(projectDataMessages.entityMissing);
    }
    const response = await relayClient.entity(scope.projectId, ref, { withVersions: true });
    const version = response.meta?.versions?.[response.data.id]?.aggregateVersion;
    return { entity: response.data, ...(version ? { expectedVersion: version } : {}) };
  });
}

/**
 * Возвращает первую bounded страницу вида с фильтрами сервера.
 */
export function useEntities(
  kind: EntityKind,
  filters: Readonly<Record<string, string>> = {},
): SWRResponse<HttpEntityPage> {
  const scope = useProject();
  return useSWR(
    [scope.serverKey, scope.projectId, "entities", kind, filters],
    async () =>
      (
        await relayClient.entities(scope.projectId, {
          sort: "key",
          ...filters,
          kind,
          offset: 0,
          limit: 40,
        })
      ).data,
  );
}

/**
 * Публикует именованные Core-проекции без приведения transport JSON в компонентах.
 */
export function useRead<K extends keyof HttpReadResults>(
  operation: K,
  parameters: HttpReadParameters[K] | undefined,
): SWRResponse<HttpReadResults[K]> {
  const scope = useProject();
  return useSWR(
    parameters ? [scope.serverKey, scope.projectId, operation, parameters] : null,
    async () => {
      if (!parameters) {
        throw new Error(projectDataMessages.parametersMissing);
      }
      return (await relayClient.read(scope.projectId, operation, parameters)).data;
    },
  );
}

/**
 * Читает текущие агрегаты обзора, вычисленные Core в одном snapshot.
 */
export function useOverview(): SWRResponse<HttpOverview> {
  const scope = useProject();
  return useSWR(
    [scope.serverKey, scope.projectId, "overview"],
    async () => (await relayClient.overview(scope.projectId)).data,
  );
}
