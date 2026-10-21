import type { PlanStage, WorkPlanRecord } from "@relay/contracts";

/**
 * Проверяемая проекция этапа: идентичность, название и упорядоченный состав задач.
 */
export type StageView = Pick<PlanStage, "id" | "title" | "taskIds">;

/**
 * Подготовленный план с единственным пустым этапом.
 */
export interface StagedPlanFixture {
  /* Сохранённый план; его ревизия защищает этапы и включения задач. */
  readonly plan: WorkPlanRecord;

  /* Единственный этап подготовленного плана без включённых задач. */
  readonly stage: StageView;
}
