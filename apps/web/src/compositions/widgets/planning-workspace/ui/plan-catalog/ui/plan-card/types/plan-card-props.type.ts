import type { PlanningPlan } from "domains/planning";

/** Параметры визуальной области. */
export type PlanCardProps = {
  /** Отображаемый план. */
  plan: PlanningPlan;
  /** Корень адресов проекта. */
  basePath: string;
};
