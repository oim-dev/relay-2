import type { ProjectScopeProps } from "./types/project-scope-props.type";
import { ProjectAddressContext, ProjectScopeContext } from "./context";

/**
 * Закрепляет проект за деревом запросов, форм и подписок.
 *
 * Используется для:
 *  - изоляции одновременно выполняемых операций разных проектов
 */
export const ProjectScope = (props: ProjectScopeProps) => {
  const { children, projectId, slug } = props;
  return (
    <ProjectScopeContext value={projectId}>
      <ProjectAddressContext value={slug ?? projectId}>{children}</ProjectAddressContext>
    </ProjectScopeContext>
  );
};
