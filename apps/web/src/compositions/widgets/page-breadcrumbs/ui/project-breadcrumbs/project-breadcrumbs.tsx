import { useLocation, useMatches } from "react-router-dom";
import { useGetProject, useProjectId, useProjectBasePath } from "domains/project";
import { useWorkspace } from "domains/workspace";
import { PageBreadcrumbs } from "../../page-breadcrumbs";
import { buildProjectBreadcrumbs } from "../../helpers/build-project-breadcrumbs";
import type { ProjectBreadcrumbsProps } from "./types/project-breadcrumbs-props.type";

/**
 * Связывает навигационный путь с текущим проектом и метаданными маршрутов.
 *
 * Используется для:
 *  - единого пути в каркасе проекта и в окне задачи
 */
export const ProjectBreadcrumbs = (props: ProjectBreadcrumbsProps) => {
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const workspace = useWorkspace();
  const project = useGetProject();
  const matches = useMatches();
  const location = useLocation();
  const projectName =
    workspace.data?.projects.find((entry) => entry.id === projectId)?.name ??
    project.data?.name ??
    "Проект";
  const items = buildProjectBreadcrumbs(matches, base, projectId, projectName, location);
  return <PageBreadcrumbs {...props} items={items} />;
};
