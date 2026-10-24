import type { PlanningTransitionContext } from "../planning/planning-transition.types";

/**
 * Явные разрешённые роли planning из переносимой границы команды, без пользовательского запроса.
 */
export type PlanningRoleContext = Pick<
  PlanningTransitionContext,
  "stageId" | "taskId" | "sourcePlanId" | "targetPlanId" | "targetStageId" | "beforeStageId"
>;
