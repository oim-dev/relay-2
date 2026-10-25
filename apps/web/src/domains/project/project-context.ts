import { createContext, useContext } from "react";
import type { ProjectScopeValue } from "./types/project.types";
import { projectDataMessages } from "./project.messages";

export const ProjectContext = createContext<ProjectScopeValue | undefined>(undefined);

/**
 * Возвращает фиксированный scope, запрещая случайные обращения без выбранного проекта.
 */
export function useProject(): ProjectScopeValue {
  const scope = useContext(ProjectContext);
  if (!scope) {
    throw new Error(projectDataMessages.scopeMissing);
  }
  return scope;
}
