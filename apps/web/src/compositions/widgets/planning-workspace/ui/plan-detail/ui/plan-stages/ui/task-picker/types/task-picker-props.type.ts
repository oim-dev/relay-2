import type { PlanningPlan, PlanStage } from "domains/planning";

/** Параметры визуальной области. */
export type TaskPickerProps = {
  /** План выбранного этапа. */
  plan: PlanningPlan;
  /** Этап-владелец выбора. */
  stage: PlanStage;
  /** Закрытие с сохранением чернового выбора. */
  onClose: () => void;
};
