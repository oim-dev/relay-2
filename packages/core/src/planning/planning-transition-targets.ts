import { isDeepStrictEqual } from "node:util";
import { RelayError, type PlanStage, type WorkPlanRecord } from "@relay/contracts";
import { planningMessages } from "./planning.messages";
import { assertPlanningMutable, requireStage } from "./planning-rules";
import type { PlanningTransitionContext } from "./planning-transition.types";

/**
 * Отклоняет изменение вне выбранной вложенной цели именованной команды.
 */
function invalidTransition(): never {
  throw new RelayError("INVALID_TRANSITION", planningMessages.invalidTransition, 4);
}

/**
 * Требует постоянный ID явной роли named-команды; отсутствие доказательства не означает no-op.
 */
function requiredRole(id: string | undefined): string {
  if (id === undefined) {
    throw new RelayError("CORRUPT_DATA", planningMessages.missingContext);
  }
  return id;
}

/**
 * Проверяет существование выбранной задачи, даже если её нет в неизменившемся составе.
 */
function selectedTask(context: PlanningTransitionContext): string {
  const taskId = requiredRole(context.taskId);
  if (context.taskIds === undefined) {
    throw new RelayError("CORRUPT_DATA", planningMessages.missingContext);
  }
  if (!context.taskIds.has(taskId)) {
    throw new RelayError("NOT_FOUND", planningMessages.missingTaskProgress, 3, { taskId });
  }
  return taskId;
}

/**
 * Проверяет роли обеих сторон готового переноса. Цель ищется среди уже загруженных
 * owners boundary; чужой stage с тем же ID не заменяет этап требуемого получателя.
 */
function assertTransferTargets(
  previous: Readonly<WorkPlanRecord>,
  next: Readonly<WorkPlanRecord>,
  context: PlanningTransitionContext,
): void {
  const taskId = selectedTask(context);
  const sourcePlanId = requiredRole(context.sourcePlanId);
  const targetPlanId = requiredRole(context.targetPlanId);
  const targetStageId = requiredRole(context.targetStageId);
  const target =
    next.id === targetPlanId
      ? next
      : (context.plans ?? context.memberships)?.find((plan) => plan.id === targetPlanId);
  if (target === undefined) {
    throw new RelayError("NOT_FOUND", planningMessages.missingPlan, 3, {
      ref: targetPlanId,
      kind: "work-plan",
    });
  }
  assertPlanningMutable(target);
  const targetStage = requireStage(target.data.stages, targetStageId);
  if (previous.id !== sourcePlanId && previous.id !== targetPlanId) {
    invalidTransition();
  }
  if (
    previous.id === sourcePlanId &&
    !previous.data.stages.some((stage) => stage.taskIds.includes(taskId))
  ) {
    throw new RelayError("NOT_FOUND", planningMessages.sourceTaskNotFound, 3, {
      taskId,
      planId: previous.id,
    });
  }
  if (next.id === targetPlanId) {
    requireStage(previous.data.stages, targetStageId);
  } else {
    if (next.data.stages.some((stage) => stage.taskIds.includes(taskId))) {
      invalidTransition();
    }
  }
  if (target.data.projectId !== next.data.projectId || !targetStage.taskIds.includes(taskId)) {
    invalidTransition();
  }
  assertMembershipScope(previous.data.stages, next.data.stages, taskId);
}

/**
 * Защищает тексты этапов и порядок всех невыбранных включений. Transfer вправе снять выбранную
 * задачу в исходном этапе и добавить в целевом, в том числе внутри одного владельца.
 * Новая вставка может соседствовать с конкурентной вставкой; порядок остальных задач неизменен.
 */
function assertMembershipScope(
  before: readonly PlanStage[],
  after: readonly PlanStage[],
  taskId: string,
): void {
  if (
    !isDeepStrictEqual(
      before.map((stage) => stage.id),
      after.map((stage) => stage.id),
    )
  ) {
    invalidTransition();
  }
  for (const [index, stage] of before.entries()) {
    const updated = after[index];
    if (updated === undefined) {
      invalidTransition();
    }
    const { taskIds: oldTasks, ...oldFields } = stage;
    const { taskIds: newTasks, ...newFields } = updated;
    if (
      !isDeepStrictEqual(oldFields, newFields) ||
      !isDeepStrictEqual(
        oldTasks.filter((id) => id !== taskId),
        newTasks.filter((id) => id !== taskId),
      ) ||
      (oldTasks.includes(taskId) === newTasks.includes(taskId) &&
        !isDeepStrictEqual(oldTasks, newTasks))
    ) {
      invalidTransition();
    }
  }
}

/**
 * Проверяет выбранный этап и сохранность остальных значений/порядка относительно canonical before.
 * Create/remove/move меняют только присутствие либо позицию цели; update сохраняет её включения.
 */
function assertStageScope(
  before: readonly PlanStage[],
  after: readonly PlanStage[],
  stageId: string,
  operation: string,
): void {
  const othersBefore = before.filter((stage) => stage.id !== stageId);
  const othersAfter = after.filter((stage) => stage.id !== stageId);
  if (!isDeepStrictEqual(othersBefore, othersAfter)) {
    invalidTransition();
  }
  if (operation === "plan.stage.create" || operation === "plan.stage.remove") {
    return;
  }
  const selectedBefore = requireStage(before, stageId);
  const selectedAfter = requireStage(after, stageId);
  if (operation === "plan.stage.move") {
    if (!isDeepStrictEqual(selectedBefore, selectedAfter)) {
      invalidTransition();
    }
  } else if (
    !isDeepStrictEqual(
      before.map((stage) => stage.id),
      after.map((stage) => stage.id),
    )
  ) {
    invalidTransition();
  }
  if (
    operation === "plan.stage.update" &&
    !isDeepStrictEqual(selectedBefore.taskIds, selectedAfter.taskIds)
  ) {
    invalidTransition();
  }
}

/**
 * Общий pure контракт адресных ролей и semantic diff готового stage/membership эффекта, включая no-op.
 * Сравнивает текущий canonical before с candidate: независимые уже принятые изменения соседей сохраняются.
 * Не исполняет пользовательский ввод, не рассчитывает позиции, ID/время и не читает хранилище.
 */
export function assertPlanningTransitionTargets(
  previous: Readonly<WorkPlanRecord>,
  next: Readonly<WorkPlanRecord>,
  context: PlanningTransitionContext,
): void {
  const operation = context.operation;
  if (!operation.startsWith("plan.stage.")) {
    return;
  }
  if (previous.key !== next.key) {
    invalidTransition();
  }
  if (operation === "plan.stage.task.transfer") {
    assertTransferTargets(previous, next, context);
    return;
  }
  if (context.beforeStageId !== undefined && context.beforeStageId !== null) {
    requireStage(previous.data.stages, context.beforeStageId);
  }
  const stageId = requiredRole(context.stageId);
  if (operation === "plan.stage.create") {
    const stage = requireStage(next.data.stages, stageId);
    if (previous.data.stages.some((stage) => stage.id === stageId) || stage.taskIds.length !== 0) {
      invalidTransition();
    }
    assertStageScope(previous.data.stages, next.data.stages, stageId, operation);
    return;
  }
  requireStage(previous.data.stages, stageId);
  assertStageScope(previous.data.stages, next.data.stages, stageId, operation);
  if (operation === "plan.stage.remove") {
    if (next.data.stages.some((stage) => stage.id === stageId)) {
      invalidTransition();
    }
    return;
  }
  const stage = requireStage(next.data.stages, stageId);
  if (operation === "plan.stage.task.add" || operation === "plan.stage.task.remove") {
    const taskId = selectedTask(context);
    if (stage.taskIds.includes(taskId) !== (operation === "plan.stage.task.add")) {
      invalidTransition();
    }
    assertMembershipScope(previous.data.stages, next.data.stages, taskId);
  }
}
