import { RelayError, validateActor, type TaskRecord, type WriteOptions } from "@relay/contracts";
import {
  changeCommandEntity,
  createCommandEntity,
  entityCommandEffect,
} from "../commands/command-entity";
import type { CommandEntityAllocation } from "../commands/command-context.types";
import { validateEntityWrite } from "../entities/entity-validation";
import { TASK_LIMITS } from "./task-constants";
import { changeTaskCriteria } from "./task-criteria";
import { taskRecord } from "./task-data";
import type { TaskGraphCache } from "./task-command-graph";
import type {
  TaskCommandDelta,
  TaskCreateAllocation,
  TaskCreateContext,
  TaskLinkContext,
  TaskMoveContext,
  TaskNestedDelta,
  TaskParentContext,
  TaskTargetContext,
} from "./task-command.types";
import { newCriterion, text } from "./task-input";
import type {
  CreateTaskInput,
  MoveTaskInput,
  ParsedTaskCriterionChange,
  TaskLinkChange,
  UpdateTaskInput,
} from "./task-input.types";
import { taskLabels, taskMessages } from "./task-messages";
import { changeTaskLink, ensureTaskTargets, ensureUniqueTaskReferences } from "./task-rules";
import { assertTaskTransition } from "./task-transition";

/**
 * Рассчитывает новую задачу из выбранного контекста, проверяет назначения и граф кандидата.
 * Не читает часы/ID/хранилище; результат готов для единственного guarded commit.
 */
export function calculateTaskCreate(
  input: CreateTaskInput,
  context: TaskCreateContext,
  allocation: TaskCreateAllocation,
  cache: TaskGraphCache,
): TaskCommandDelta {
  const dependencies = context.dependencies.map((record) => record.id);
  const related = context.related.map((record) => record.id);
  ensureUniqueTaskReferences(dependencies, taskLabels.dependencies);
  ensureUniqueTaskReferences(related, taskLabels.related);
  // Входные алиасы одной цели дают INVALID_ARGUMENT, а не ошибку декодирования кандидата.
  ensureTaskTargets(context.targets, context.board, []);
  const acceptanceCriteria = input.acceptanceCriteria.map((content, index) => {
    const id = allocation.criterionIds[index];
    if (id === undefined) {
      throw new RelayError("CORRUPT_DATA", taskMessages.transitionContext);
    }
    return newCriterion(content, id);
  });
  const record = taskRecord(
    createCommandEntity(
      "task",
      allocation.key,
      {
        boardId: context.board.id,
        title: input.title,
        description: input.description,
        column: input.column,
        parentId: context.parent?.id ?? null,
        dependencies,
        related,
        targets: context.targets.map((target) => target.id),
        acceptanceCriteria,
        comments: [],
      },
      allocation,
    ),
  );
  assertTaskTransition(null, record, {
    operation: "task.create",
    board: context.board,
    targets: context.targets,
    graph: cache.get(context.graphRecords, record),
  });
  return { record, effects: entityCommandEffect(null, record) };
}

/**
 * Рассчитывает правку текста/целей под исходным CAS; no-op не создаёт эффект и не требует графа.
 */
export function calculateTaskUpdate(
  current: TaskRecord,
  input: UpdateTaskInput,
  context: TaskTargetContext | undefined,
  write: WriteOptions,
  timestamp: string,
): TaskCommandDelta {
  validateEntityWrite(current, write);
  if (input.targets !== undefined && context === undefined) {
    throw new RelayError("CORRUPT_DATA", taskMessages.transitionContext);
  }
  if (context !== undefined) {
    ensureTaskTargets(context.targets, context.board, current.data.targets);
  }
  const record = taskRecord(
    changeCommandEntity(
      current,
      {
        title: input.title ?? current.data.title,
        description: input.description ?? current.data.description,
        ...(context === undefined ? {} : { targets: context.targets.map((target) => target.id) }),
      },
      write,
      timestamp,
    ),
  );
  assertTaskTransition(current, record, { operation: "task.update", ...context });
  return { record, effects: entityCommandEffect(current, record) };
}

/**
 * Рассчитывает перенос с точным новым ключом и проверкой завершения даже при no-op.
 */
export function calculateTaskMove(
  current: TaskRecord,
  input: MoveTaskInput,
  context: TaskMoveContext,
  write: WriteOptions,
  timestamp: string,
  cache: TaskGraphCache,
): TaskCommandDelta {
  const record = taskRecord(
    changeCommandEntity(
      current,
      {
        boardId: context.board.id,
        column: input.column ?? current.data.column,
      },
      write,
      timestamp,
      context.key,
    ),
  );
  assertTaskTransition(current, record, {
    operation: "task.move",
    board: context.board,
    targets: context.targets,
    graph: cache.get(context.graphRecords, record),
  });
  return { record, effects: entityCommandEffect(current, record) };
}

/**
 * Рассчитывает назначение/снятие родителя; общий граф отвергает цикл и нового ребёнка done-родителя.
 */
export function calculateTaskParent(
  current: TaskRecord,
  context: TaskParentContext,
  write: WriteOptions,
  timestamp: string,
  cache: TaskGraphCache,
): TaskCommandDelta {
  const record = taskRecord(
    changeCommandEntity(current, { parentId: context.parent?.id ?? null }, write, timestamp),
  );
  assertTaskTransition(current, record, {
    operation: context.parent === null ? "task.parent.clear" : "task.parent.set",
    graph: cache.get(context.graphRecords, record),
  });
  return { record, effects: entityCommandEffect(current, record) };
}

/**
 * Рассчитывает связь под CAS до no-op; related также проверяет целостность общего графа.
 */
export function calculateTaskLink(
  current: TaskRecord,
  change: TaskLinkChange,
  context: TaskLinkContext,
  write: WriteOptions,
  timestamp: string,
  cache: TaskGraphCache,
): TaskCommandDelta {
  validateEntityWrite(current, write);
  const record = taskRecord(
    changeCommandEntity(
      current,
      {
        ...changeTaskLink(current, context.target.id, change),
      },
      write,
      timestamp,
    ),
  );
  const operation =
    change.field === "dependencies"
      ? `task.dependency.${change.action}`
      : `task.${change.action === "add" ? "link" : "unlink"}`;
  assertTaskTransition(current, record, {
    operation,
    graph: cache.get(context.graphRecords, record),
  });
  return { record, effects: entityCommandEffect(current, record) };
}

/**
 * Рассчитывает критерий без графа; добавление получает заранее выделенный ID.
 * Сохраняет исходный CAS и запрет изменения критериев в done даже для no-op.
 */
export function calculateTaskCriterion(
  current: TaskRecord,
  input: ParsedTaskCriterionChange,
  criterionId: string,
  write: WriteOptions,
  timestamp: string,
): TaskNestedDelta {
  validateEntityWrite(current, write);
  const change =
    input.action === "add"
      ? { action: "add" as const, criterion: newCriterion(input.content, criterionId) }
      : input;
  const acceptanceCriteria = changeTaskCriteria(current.data, change, {
    actor: write.actor,
    timestamp,
  });
  const record = taskRecord(changeCommandEntity(current, { acceptanceCriteria }, write, timestamp));
  const id = input.action === "add" ? criterionId : input.criterionId;
  assertTaskTransition(current, record, {
    operation: `task.criterion.${input.action}`,
    criterionId: id,
    actor: write.actor,
    timestamp,
  });
  return {
    id,
    record,
    effects: entityCommandEffect(current, record),
  };
}

/**
 * Рассчитывает только append-effect комментария, не изменяя содержание и его ревизию.
 * Проекция журнала нужна лишь для ответа; фактический журнал заполняет общий commit finalizer.
 */
export function calculateTaskComment(
  current: TaskRecord,
  body: string,
  title: string,
  allocation: CommandEntityAllocation,
): TaskNestedDelta {
  validateActor(allocation.actor);
  const comment = {
    id: allocation.id,
    body: text(body, taskLabels.commentBody, TASK_LIMITS.commentBody, { required: true }),
    title: text(title, taskLabels.commentTitle, TASK_LIMITS.commentTitle, { singleLine: true }),
    createdAt: allocation.timestamp,
    createdBy: allocation.actor,
  };
  const record = {
    ...current,
    data: { ...current.data, comments: [...current.data.comments, comment] },
  };
  assertTaskTransition(current, record, { operation: "task.comment.add" });
  return { id: comment.id, record, effects: [{ kind: "comment", taskId: current.id, comment }] };
}
