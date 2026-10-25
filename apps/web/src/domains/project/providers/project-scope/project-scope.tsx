import { useMemo, type ReactElement } from "react";
import type { ProjectScopeProps } from "../../types/project.types";
import { ProjectContext } from "../../project-context";

/**
 * Закрепляет проект за деревом запросов, форм и подписок.
 *
 * Используется для:
 *  - изоляции одновременно выполняемых операций разных проектов
 */
export const ProjectScope = (props: ProjectScopeProps): ReactElement => {
  const { children, projectId, actor, serverKey } = props;
  const scope = useMemo(() => ({ projectId, actor, serverKey }), [projectId, actor, serverKey]);
  return <ProjectContext value={scope}>{children}</ProjectContext>;
};
