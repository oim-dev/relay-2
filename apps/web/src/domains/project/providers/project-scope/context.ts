import { createContext, useContext } from "react";

export const ProjectScopeContext = createContext<string | undefined>(undefined);
export const ProjectAddressContext = createContext<string | undefined>(undefined);

/**
 * Возвращает канонический путь Web отдельно от постоянного ID запросов и черновиков.
 */
export const useProjectBasePath = (): string => {
  const address = useContext(ProjectAddressContext);
  const projectId = useProjectId();
  return `/projects/${encodeURIComponent(address ?? projectId)}`;
};

/** Возвращает идентичность проекта, закреплённую за текущим деревом интерфейса. */
export const useProjectId = (): string => {
  const projectId = useContext(ProjectScopeContext);
  if (projectId === undefined) throw new Error("Отсутствует ProjectScope");
  return projectId;
};
