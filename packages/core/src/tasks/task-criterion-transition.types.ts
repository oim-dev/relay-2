import type { TaskCriterionAction } from "./task-input.types";

/**
 * Явная цель проверки одного перехода критериев, без чтений и повторного исполнения команды.
 */
export interface TaskCriterionTransitionContext {
  /* Действие именованной команды; отсутствие проверяет общий before/after-инвариант. */
  readonly action?: TaskCriterionAction;
  /* Постоянный ID выбранного критерия; обязателен при action, включая no-op и удаление. */
  readonly criterionId?: string;
  /* Известный автор исходного перехода; проверяется только при новой отметке false → true. */
  readonly actor?: string;
  /* Известное выделенное время перехода; сравнивается дословно, без выбора победителя по часам. */
  readonly timestamp?: string;
}
