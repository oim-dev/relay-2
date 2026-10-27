import useSWR from "swr";
import type { SWRResponse } from "swr";
import { relayClient } from "infra/tasks-api";
import { mapWorkspace } from "./workspace-mapper";
import type { RelayWorkspace } from "./workspace.types";

/**
 * Читает фиксированный bootstrap-каталог Server; не выдаёт его за живые настройки БД.
 */
async function getWorkspace(): Promise<RelayWorkspace> {
  return mapWorkspace((await relayClient.context()).data);
}

/**
 * Общий кеш реестра текущего origin. Идентичность проекта не зависит от его slug.
 */
export const useWorkspace = (): SWRResponse<RelayWorkspace, Error> =>
  useSWR(["relay/workspace", typeof location === "undefined" ? "" : location.origin], getWorkspace);
