/**
 * Правила записи и явных составов планирования без обращения к хранилищу.
 * Согласованность переданных записей и границу транзакции обеспечивает вызывающий сценарий.
 */
import {
  RelayError,
  validateActor,
  type PlanStage,
  type PlanningRecord,
  type WorkPlanRecord,
  type WriteOptions,
} from "@relay/contracts";
import { object, revision } from "./planning-validation";
import { planningMessages } from "./planning.messages";
import type { AllowedTaskMembership } from "./planning.types";

/**
 * Определяет план, состав которого резервирует текущее включение задачи.
 */
export function openPlan(plan: Readonly<WorkPlanRecord>): boolean {
  return plan.data.status === "draft" || plan.data.status === "active";
}

/**
 * Проверяет автора и ревизию изменяемой записи до запрета закрытого состояния и любого no-op.
 * ifRevision принадлежит плану или релизу, а не включённым задачам и планам состава.
 */
export function assertPlanningWritable(
  entity: Readonly<PlanningRecord>,
  options: Readonly<WriteOptions>,
): void {
  object(options, ["actor", "ifRevision"]);
  validateActor(options.actor);
  const expected = revision(options.ifRevision);
  if (entity.revision !== expected) {
    throw new RelayError("REVISION_CONFLICT", planningMessages.revisionConflict, 4, {
      id: entity.id,
      expectedRevision: expected,
      actualRevision: entity.revision,
    });
  }
  if (entity.kind === "work-plan" && !openPlan(entity)) {
    throw new RelayError("PLAN_READ_ONLY", planningMessages.planReadOnly, 4);
  }
  if (entity.kind === "release" && entity.data.status === "released") {
    throw new RelayError("RELEASE_READ_ONLY", planningMessages.releaseReadOnly, 4);
  }
}

/**
 * Находит позицию этапа в указанном плане или возвращает NOT_FOUND.
 */
export function stageIndex(stages: readonly PlanStage[], stageId: string): number {
  const index = stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) {
    throw new RelayError("NOT_FOUND", planningMessages.stageNotFound, 3, { stageId });
  }
  return index;
}

/**
 * Возвращает существующий этап без изменения состава; отсутствие имеет предметный код NOT_FOUND.
 */
export function requireStage(stages: readonly PlanStage[], stageId: string): PlanStage {
  const stage = stages.find((item) => item.id === stageId);
  if (stage === undefined) {
    throw new RelayError("NOT_FOUND", planningMessages.stageNotFound, 3, { stageId });
  }
  return stage;
}

/**
 * Запрещает второе включение задачи в открытый план или другой этап.
 * Разрешённый адрес — текущее включение при повторе команды либо источник переноса.
 * Исторические включения закрытых планов не резервируют задачу; данные не изменяются.
 */
export function assertTaskAvailable(
  plans: readonly WorkPlanRecord[],
  taskId: string,
  allowed: AllowedTaskMembership,
): void {
  for (const plan of plans) {
    if (!openPlan(plan)) {
      continue;
    }
    for (const stage of plan.data.stages) {
      if (
        stage.taskIds.includes(taskId) &&
        (plan.id !== allowed.planId || stage.id !== allowed.stageId)
      ) {
        throw new RelayError("MEMBERSHIP_CONFLICT", planningMessages.membershipConflict, 4, {
          taskId,
          planId: plan.id,
          stageId: stage.id,
        });
      }
    }
  }
}

/**
 * Разрешает начало только черновика с непустой целью и хотя бы одной включённой задачей.
 * Фактическое выполнение задач для начала не требуется.
 */
export function assertPlanCanStart(plan: Readonly<WorkPlanRecord>): void {
  if (plan.data.status !== "draft") {
    throw new RelayError("INVALID_TRANSITION", planningMessages.startRequiresDraft, 4);
  }
  if (!plan.data.goal.trim() || !plan.data.stages.some((stage) => stage.taskIds.length)) {
    throw new RelayError("NOT_READY", planningMessages.startRequiresGoalAndTasks, 4);
  }
}
