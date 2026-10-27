import useSWR from "swr";
import { useEffect } from "react";
import { subscribeWorkspace } from "infra/workspace-events";
import type { SWRResponse } from "swr";
import { getProject } from "../../project";
import type { Project } from "../../project";
import { getProjectKey } from "./get-project-key";
import { useProjectId } from "../../providers/project-scope/context";

/**
 * Предоставляет общий контекст текущего локального сервера.
 */
export const useGetProject = (): SWRResponse<Project, Error> => {
  const projectId = useProjectId();
  const query = useSWR<Project, Error>(
    getProjectKey(projectId),
    ([, id]: readonly [string, string]) => getProject(id),
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
