import { useProjectId } from "domains/project";
import { ReleasesView } from "./ui/releases-view/releases-view";

/**
 * Открывает самостоятельные релизы в изолированной области выбранного проекта.
 *
 * Используется для:
 *  - выбора состава и состояния будущего выпуска
 */
export const ReleasesScreen = () => {
  const projectId = useProjectId();
  return <ReleasesView key={projectId} />;
};
