import { RelayError, type TaskRecord } from "@relay/contracts";
import { TASK_CRITERION_ACTIONS } from "./task-constants";
import { assertTaskCriteriaTransition } from "./task-criterion-transition";
import { taskMessages } from "./task-messages";
import { ensureTaskDone, ensureTaskParentAccepts, ensureTaskTargets } from "./task-rules";
import type { TaskTransitionContext } from "./task-transition.types";

/**
 * Проверяет предметные ограничения точного before/after без исполнения пользовательской команды.
 * Старый done не проверяется повторно после позднего переоткрытия зависимости: основание —
 * только текущий create/move, новая зависимость или новый родитель на границе этого шага.
 * Неграфовые изменения текста, комментария и критериев не требуют загрузки графа.
 */
export function assertTaskTransition(
  previous: TaskRecord | null,
  next: TaskRecord,
  context: TaskTransitionContext,
): void {
  const operation = context.operation;
  const moved =
    previous !== null &&
    (previous.data.boardId !== next.data.boardId || previous.data.column !== next.data.column);
  const dependenciesChanged =
    previous !== null &&
    JSON.stringify(previous.data.dependencies) !== JSON.stringify(next.data.dependencies);
  const parentChanged = previous !== null && previous.data.parentId !== next.data.parentId;
  const linksChanged =
    previous !== null &&
    JSON.stringify(previous.data.related) !== JSON.stringify(next.data.related);
  const graphOperation =
    operation === "task.move" ||
    operation?.startsWith("task.parent.") ||
    operation?.startsWith("task.dependency.") ||
    operation === "task.link" ||
    operation === "task.unlink";
  if (
    previous === null ||
    moved ||
    dependenciesChanged ||
    parentChanged ||
    linksChanged ||
    graphOperation
  ) {
    const graph = context.graph;
    if (graph === undefined) {
      throw new RelayError("CORRUPT_DATA", taskMessages.transitionContext);
    }
    const addedDependency =
      previous !== null &&
      next.data.dependencies.some((id) => !previous.data.dependencies.includes(id));
    if (previous === null || moved || operation === "task.move" || addedDependency) {
      ensureTaskDone(next, graph);
    }
    ensureTaskParentAccepts(next, previous?.data.parentId ?? null, graph);
  }
  const criteriaChanged =
    previous !== null &&
    JSON.stringify(previous.data.acceptanceCriteria) !==
      JSON.stringify(next.data.acceptanceCriteria);
  if (
    previous?.data.column === "done" &&
    (criteriaChanged || operation?.startsWith("task.criterion."))
  ) {
    throw new RelayError("TASK_DONE", taskMessages.taskDone, 2);
  }
  const criterionAction = TASK_CRITERION_ACTIONS.find(
    (action) => operation === `task.criterion.${action}`,
  );
  assertTaskCriteriaTransition(
    previous?.data.acceptanceCriteria ?? [],
    next.data.acceptanceCriteria,
    {
      ...(criterionAction === undefined ? {} : { action: criterionAction }),
      ...(context.criterionId === undefined ? {} : { criterionId: context.criterionId }),
      ...(context.actor === undefined ? {} : { actor: context.actor }),
      ...(context.timestamp === undefined ? {} : { timestamp: context.timestamp }),
    },
  );
  const targetsChanged =
    previous !== null &&
    JSON.stringify(previous.data.targets) !== JSON.stringify(next.data.targets);
  if (previous === null || moved || targetsChanged || context.targets !== undefined) {
    if (
      context.board === undefined ||
      context.targets === undefined ||
      context.board.id !== next.data.boardId
    ) {
      throw new RelayError("CORRUPT_DATA", taskMessages.transitionContext);
    }
    ensureTaskTargets(
      context.targets,
      context.board,
      previous?.data.boardId === next.data.boardId ? previous.data.targets : [],
    );
  }
}
