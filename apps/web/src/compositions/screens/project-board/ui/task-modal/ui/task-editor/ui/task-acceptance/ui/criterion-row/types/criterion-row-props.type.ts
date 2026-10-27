import type { ComponentPropsWithoutRef } from "react";
import type { CriterionSummary } from "domains/board-tasks";

/** Параметры визуальной области. */
export type CriterionRowParams = {
  /** Проект записи. */
  projectId: string;
  /** Задача-владелец. */
  taskId: string;
  /** Краткое содержание критерия. */
  criterion: CriterionSummary;
  /** Запись временно недоступна. */
  isDisabled: boolean;
  /** Явное состояние выполнения. */
  onComplete: (completed: boolean) => void;
  /** Открыть форму. */
  onEdit: () => void;
  /** Запросить удаление. */
  onRemove: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type CriterionRowProps = RootAttrs & CriterionRowParams;
