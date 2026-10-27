import type { PlanningPlan } from "domains/planning";

/** Параметры визуальной области. */
export type PlanDetailProps = {
  /** Открытый план. */
  plan: PlanningPlan;
  /** Корень адресов проекта. */
  basePath: string;
  /** Редактирование описания плана. */
  onEdit: () => void;
};
