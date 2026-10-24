import type { EntityIdentity, TaskProgress, WorkPlanRecord } from "@relay/contracts";

/**
 * Основания уже рассчитанного перехода. Все данные относятся к одной command boundary.
 * Необязательные проекции требуются только при затрагивающем их изменении; отсутствие
 * необходимого материала является ошибкой, а не разрешением пропустить проверку.
 */
export interface PlanningTransitionContext {
  /* Точное имя предметной команды plan.* или release.*. */
  readonly operation: string;
  /* Дословно проверяемый автор перехода. */
  readonly actor: string;
  /* Планы выбранного состава релиза; обязательны при его изменении, replan и publish. */
  readonly plans?: readonly WorkPlanRecord[];
  /* Прогресс общего графа на этой boundary; нужен только новому complete/publish. */
  readonly taskProgress?: ReadonlyMap<string, TaskProgress>;
  /* Полный набор относящихся к включаемым задачам планов после атомарного переноса. */
  readonly memberships?: readonly WorkPlanRecord[];
  /* Существующие задачи новых включений; исходный набор достаточен, задачи не меняются. */
  readonly taskIds?: ReadonlySet<string>;
  /* Разрешённые цели новой области плана. */
  readonly scope?: readonly EntityIdentity[];
  /* Выбранный либо выделенный этап; обязателен для named plan.stage.*, кроме transfer. */
  readonly stageId?: string;
  /* Выбранная задача named включения/исключения/переноса, включая no-op. */
  readonly taskId?: string;
  /* Обязательный исходный владелец transfer; прежнее включение требуется и при переносе внутри плана. */
  readonly sourcePlanId?: string;
  /* Этап получателя переноса; проверяется именно внутри targetPlanId. */
  readonly targetStageId?: string;
  /* Владелец целевого этапа переноса; может совпадать с исходным планом. */
  readonly targetPlanId?: string;
  /* Этап назначения порядка; null означает конец, отсутствие — иной способ перемещения. */
  readonly beforeStageId?: string | null;
}
