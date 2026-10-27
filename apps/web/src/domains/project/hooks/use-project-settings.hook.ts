import useSWR from "swr";
import { useEffect } from "react";
import { subscribeWorkspace } from "infra/workspace-events";
import type { SWRResponse } from "swr";
import { useProjectId } from "../providers/project-scope/context";
import { useGetProject } from "./use-get-project/use-get-project.hook";
import { getProjectSettings, saveProjectSettings } from "../settings";
import type { ProjectSettings, SaveProjectSettingsInput } from "../settings";

/**
 * Следит за настройками, не меняя идентичность кеша при переименовании slug.
 */
export const useProjectSettings = (): SWRResponse<ProjectSettings, Error> => {
  const projectId = useProjectId();
  const query = useSWR<ProjectSettings, Error>(["project-settings", projectId], () =>
    getProjectSettings(projectId),
  );
  const { mutate } = query;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected") void mutate().catch(() => undefined);
      }),
    [projectId, mutate],
  );
  return query;
};

/**
 * Согласует подтверждённые настройки и шапку. Bootstrap-каталог Server не меняется
 * после записи настроек, поэтому повторный context не считается обновлением aliases.
 */
export const useSaveProjectSettings = (): ((
  input: SaveProjectSettingsInput,
) => Promise<ProjectSettings>) => {
  const projectId = useProjectId();
  const settings = useProjectSettings();
  const project = useGetProject();
  return async (input) => {
    const saved = await saveProjectSettings(projectId, input);
    await settings.mutate(saved, { revalidate: false });
    // Запись уже подтверждена: сбой фонового перечитывания не превращает её в ошибку записи.
    await project.mutate().catch(() => undefined);
    return saved;
  };
};
