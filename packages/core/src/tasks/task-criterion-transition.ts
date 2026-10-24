import { RelayError, type TaskCriterion } from "@relay/contracts";
import { TASK_CRITERION_FIELDS, TASK_LIMITS } from "./task-constants";
import { findTaskCriterion } from "./task-criteria";
import type { TaskCriterionTransitionContext } from "./task-criterion-transition.types";
import type { TaskCriterionAction } from "./task-input.types";
import { taskMessages } from "./task-messages";

/**
 * Отклоняет недопустимый before/after-переход с точным ID критерия.
 */
function invalidCriterionTransition(id: string): never {
  throw new RelayError("INVALID_ARGUMENT", taskMessages.criterionTransition, 2, { id });
}

/**
 * Сравнивает только пользовательские тексты одного критерия без метаданных приёмки.
 */
function sameCriterionText(previous: TaskCriterion, next: TaskCriterion): boolean {
  return TASK_CRITERION_FIELDS.every((field) => previous[field] === next[field]);
}

/**
 * Проверяет, что существующая отметка приёмки сохранила исходное авторство и время.
 */
function sameCriterionCompletion(previous: TaskCriterion, next: TaskCriterion): boolean {
  return (
    previous.completed === next.completed &&
    previous.completedAt === next.completedAt &&
    previous.completedBy === next.completedBy
  );
}

/**
 * Проверяет переход одного существующего либо нового критерия.
 * Новый критерий и новый текст всегда начинаются без приёмки; повторная отметка
 * выполненного критерия не может переписать автора и время первого выполнения.
 * Новая отметка согласуется с известными выделенными метаданными исходного перехода;
 * отсутствующие legacy-основания не выводятся из часов или самой карточки.
 */
function assertCriterionLifecycle(
  previous: TaskCriterion | undefined,
  next: TaskCriterion,
  context: TaskCriterionTransitionContext,
): void {
  if (!next.completed && (next.completedAt !== null || next.completedBy !== null)) {
    invalidCriterionTransition(next.id);
  }
  if (previous === undefined || !sameCriterionText(previous, next)) {
    if (next.completed || next.completedAt !== null || next.completedBy !== null) {
      invalidCriterionTransition(next.id);
    }
  } else if (previous.completed && next.completed && !sameCriterionCompletion(previous, next)) {
    invalidCriterionTransition(next.id);
  } else if (!previous.completed && next.completed) {
    if (
      (context.actor !== undefined && next.completedBy !== context.actor) ||
      (context.timestamp !== undefined && next.completedAt !== context.timestamp)
    ) {
      invalidCriterionTransition(next.id);
    }
  }
}

/**
 * Проверяет форму выбранной операции: цель существует, остальные критерии и порядок
 * сохраняются, add дописывает ровно один новый элемент, remove действительно удаляет его.
 */
function assertCriterionAction(
  previous: readonly TaskCriterion[],
  next: readonly TaskCriterion[],
  context: TaskCriterionTransitionContext,
): void {
  const { action, criterionId } = context;
  if (action === undefined) {
    return;
  }
  if (criterionId === undefined) {
    throw new RelayError("CORRUPT_DATA", taskMessages.transitionContext);
  }
  const before = action === "add" ? undefined : findTaskCriterion(previous, criterionId);
  const after = action === "remove" ? undefined : findTaskCriterion(next, criterionId);
  const ids = previous.map((criterion) => criterion.id);
  let expectedIds = ids;
  if (action === "add") {
    expectedIds = [...ids, criterionId];
  } else if (action === "remove") {
    expectedIds = ids.filter((id) => id !== criterionId);
  }
  if (JSON.stringify(expectedIds) !== JSON.stringify(next.map((criterion) => criterion.id))) {
    invalidCriterionTransition(criterionId);
  }
  if (action === "add" && (ids.includes(criterionId) || next.length > TASK_LIMITS.criteria)) {
    invalidCriterionTransition(criterionId);
  }
  for (const criterion of next) {
    if (criterion.id !== criterionId) {
      const retained = findTaskCriterion(previous, criterion.id);
      if (
        !sameCriterionText(retained, criterion) ||
        !sameCriterionCompletion(retained, criterion)
      ) {
        invalidCriterionTransition(criterion.id);
      }
    }
  }
  if (before !== undefined && after !== undefined) {
    assertSelectedCriterionState(before, after, action);
  }
}

/**
 * Проверяет состояние выбранного сохранённого критерия для update/complete/reopen.
 * Неизменный update сохраняет отметку; complete/reopen не имеют права менять тексты.
 */
function assertSelectedCriterionState(
  previous: TaskCriterion,
  next: TaskCriterion,
  action: TaskCriterionAction,
): void {
  const sameText = sameCriterionText(previous, next);
  if (action === "update") {
    if (sameText && !sameCriterionCompletion(previous, next)) {
      invalidCriterionTransition(next.id);
    }
  } else if (action === "complete" && (!sameText || !next.completed)) {
    invalidCriterionTransition(next.id);
  } else if (action === "reopen" && (!sameText || next.completed)) {
    invalidCriterionTransition(next.id);
  }
}

/**
 * Проверяет before/after-состав одной границы команды, не исполняя её повторно.
 * Контекст именованной операции включает явный ID, а не первый прочитанный критерий.
 * Раздельные переходы update → complete допустимы: между ними критерий уже сброшен.
 * Входные массивы не изменяются; граф и хранилище не требуются.
 */
export function assertTaskCriteriaTransition(
  previous: readonly TaskCriterion[],
  next: readonly TaskCriterion[],
  context: TaskCriterionTransitionContext = {},
): void {
  const before = new Map(previous.map((criterion) => [criterion.id, criterion]));
  for (const criterion of next) {
    assertCriterionLifecycle(before.get(criterion.id), criterion, context);
  }
  assertCriterionAction(previous, next, context);
}
