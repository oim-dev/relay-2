/**
 * Чистые переходы критериев приёмки без чтения БД, генерации ID и получения текущего времени.
 */
import { RelayError, type TaskCriterion, type TaskData } from "@relay/contracts";
import { TASK_CRITERION_FIELDS, TASK_LIMITS } from "./task-constants";
import type { TaskCriterionChange, TaskCriterionCompletion } from "./task-input.types";
import { taskMessages } from "./task-messages";

/**
 * Находит критерий по постоянному ID внутри одной задачи либо возвращает NOT_FOUND.
 */
export function findTaskCriterion(criteria: readonly TaskCriterion[], id: string): TaskCriterion {
  const criterion = criteria.find((item) => item.id === id);
  if (criterion === undefined) {
    throw new RelayError("NOT_FOUND", taskMessages.criterionNotFound, 3, { id });
  }
  return criterion;
}

/**
 * Рассчитывает изменение критериев, не меняя входную задачу и её вложенные объекты.
 * В done запрещены все действия. Новый текст снимает отметку, неизменный её сохраняет;
 * повторное complete сохраняет автора и время первой отметки. CAS принадлежит вызывающему сервису.
 */
export function changeTaskCriteria(
  data: TaskData,
  change: TaskCriterionChange,
  completion: TaskCriterionCompletion,
): TaskCriterion[] {
  if (data.column === "done") {
    throw new RelayError("TASK_DONE", taskMessages.taskDone, 2);
  }
  if (change.action === "add") {
    if (data.acceptanceCriteria.length >= TASK_LIMITS.criteria) {
      throw new RelayError("INVALID_ARGUMENT", taskMessages.criteriaLimit(TASK_LIMITS.criteria), 2);
    }
    return [...data.acceptanceCriteria, change.criterion];
  }
  const previous = findTaskCriterion(data.acceptanceCriteria, change.criterionId);
  if (change.action === "remove") {
    return data.acceptanceCriteria.filter((criterion) => criterion.id !== previous.id);
  }
  let changed: TaskCriterion = previous;
  if (change.action === "update") {
    const content = { ...previous, ...change.fields };
    if (TASK_CRITERION_FIELDS.some((field) => content[field] !== previous[field])) {
      changed = { ...content, completed: false, completedAt: null, completedBy: null };
    }
  } else if (change.action === "complete" && !previous.completed) {
    changed = {
      ...previous,
      completed: true,
      completedAt: completion.timestamp,
      completedBy: completion.actor,
    };
  } else if (change.action === "reopen") {
    changed = { ...previous, completed: false, completedAt: null, completedBy: null };
  }
  return data.acceptanceCriteria.map((criterion) =>
    criterion.id === changed.id ? changed : criterion,
  );
}
