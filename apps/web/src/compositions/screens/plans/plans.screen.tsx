import { PlanningWorkspace } from "compositions/widgets/planning-workspace";
import { useProjectId } from "domains/project";

/**
 * Открывает пространство планов выбранного проекта.
 *
 * Используется для:
 *  - просмотра серверного каталога и адресных подробностей плана
 */
export const PlansScreen = () => {
  const projectId = useProjectId();
  return <PlanningWorkspace key={projectId} />;
};
