import type { PlanStage } from "domains/planning";

/** Один этап с собственным чтением страниц задач. */
export type StageRowProps = {
  /** План-владелец. */
  planId: string;
  /** Этап. */
  stage: PlanStage;
  /** Номер в полном порядке. */
  index: number;
  /** Полное число этапов. */
  total: number;
  /** Доступно изменение. */
  canEdit: boolean;
  /** Есть неподтверждённое действие. */
  isBusy: boolean;
  /** Адресное чтение задачи. */
  onOpenTask: (id: string) => void;
  /** Редактор этапа. */
  onEdit: () => void;
  /** Выбор задач. */
  onChoose: () => void;
  /** Удаление пустого этапа. */
  onRemove: () => void;
  /** Изменение порядка полного списка. */
  onMove: (direction: "up" | "down") => void;
};
