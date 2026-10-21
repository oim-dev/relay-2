/**
 * Чистые ограничения задачи: допустимость целей, обязательств и направленных связей.
 * Вызывающий сервис получает согласованный снимок и сохраняет результат под CAS задачи.
 */
import { RelayError, type KnowledgeRecord, type TaskData, type TaskRecord } from "@relay/contracts";
import { TASK_LIMITS } from "./task-constants";
import type { TaskTarget } from "./task-data.types";
import type { TaskGraph } from "./task-graph";
import type { TaskLinkChange } from "./task-input.types";
import { taskMessages } from "./task-messages";

/**
 * Проверяет уникальность уже разрешённых задач, включая разные алиасы одной записи.
 */
export function ensureUniqueTaskReferences(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new RelayError("INVALID_ARGUMENT", taskMessages.duplicateTasks(label), 2);
  }
}

/**
 * Проверяет цели доски; снятая реализация допустима лишь как сохранённое прежнее назначение.
 * При переносе между досками retained должен быть пустым. Входные коллекции не изменяются.
 */
export function ensureTaskTargets(
  targets: readonly TaskTarget[],
  board: KnowledgeRecord<"board">,
  retained: readonly string[],
): void {
  const ids = targets.map((target) => target.id);
  if (new Set(ids).size !== ids.length) {
    throw new RelayError("INVALID_ARGUMENT", taskMessages.duplicateTargets, 2);
  }
  for (const target of targets) {
    const applicationId = board.data.applicationId;
    if (applicationId !== undefined) {
      if (target.kind !== "implementation" || target.data.applicationId !== applicationId) {
        throw new RelayError("INVALID_ARGUMENT", taskMessages.applicationTargets, 2);
      }
      if (!target.data.active && !retained.includes(target.id)) {
        throw new RelayError("INVALID_ARGUMENT", taskMessages.inactiveTarget, 2);
      }
    } else if (board.data.slug === "product") {
      if (target.kind !== "feature" && target.kind !== "scenario") {
        throw new RelayError("INVALID_ARGUMENT", taskMessages.productTargets, 2);
      }
    } else {
      throw new RelayError("INVALID_ARGUMENT", taskMessages.unsupportedBoardTargets, 2);
    }
  }
}

/**
 * Отклоняет сохранение done при невыполненных собственных критериях или обязательствах.
 * Граф должен уже содержать кандидат задачи и принадлежать той же транзакции записи.
 */
export function ensureTaskDone(record: TaskRecord, graph: TaskGraph): void {
  if (record.data.column !== "done") {
    return;
  }
  const progress = graph.progress(record.id);
  if (!progress.canComplete) {
    throw new RelayError("TASK_INCOMPLETE", taskMessages.incomplete, 2, {
      id: record.id,
      blockers: progress.blockers,
    });
  }
}

/**
 * Запрещает нового невыполненного ребёнка у done-родителя; повтор прежней связи допустим.
 * Проверяется транзитивное выполнение ребёнка, а не только его сохранённая колонка.
 */
export function ensureTaskParentAccepts(
  record: TaskRecord,
  previousParent: string | null,
  graph: TaskGraph,
): void {
  const parentId = record.data.parentId;
  if (
    parentId !== null &&
    parentId !== previousParent &&
    graph.column(parentId) === "done" &&
    !graph.progress(record.id).completed
  ) {
    throw new RelayError("TASK_DONE", taskMessages.completedParent, 2);
  }
}

/**
 * Рассчитывает идемпотентную правку одной связи, сохраняя порядок остальных ID.
 * Самоссылка и превышение лимита отвергаются до записи; исходное содержание не изменяется.
 */
export function changeTaskLink(
  record: TaskRecord,
  targetId: string,
  change: TaskLinkChange,
): TaskData {
  if (record.id === targetId) {
    throw new RelayError("INVALID_ARGUMENT", taskMessages.selfReference, 2);
  }
  const values = record.data[change.field];
  const next =
    change.action === "remove"
      ? values.filter((id) => id !== targetId)
      : [...new Set([...values, targetId])];
  if (next.length > TASK_LIMITS.links) {
    throw new RelayError("INVALID_ARGUMENT", taskMessages.linksLimit(TASK_LIMITS.links), 2);
  }
  return { ...record.data, [change.field]: next };
}

/**
 * Сравнивает декодированное содержание для no-op; порядок критериев, связей и комментариев значим.
 * Ожидаемая ревизия должна быть проверена вызывающим сценарием до этого сравнения.
 */
export function sameTaskData(left: TaskData, right: TaskData): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
