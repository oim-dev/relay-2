import {
  TASK_COLUMNS,
  type NamedCommand,
  type TaskColumn,
  type TaskCriterion,
} from "@relay/contracts";
import { isEmptyArray } from "shared/value-predicates";
import type { TaskSnapshot } from "../types/tasks.types";
import type {
  TaskCommentInput,
  TaskContentInput,
  TaskCreateInput,
  TaskCriterionEditInput,
  TaskPlacementInput,
  TaskRelationInput,
} from "../types/task-commands.types";

/**
 * Добавляет постоянный ID и оба исходных guard к команде содержания задачи.
 * Input задаётся предметными адаптерами ниже; свежие версии не подставляются.
 */
function guardedTaskCommand(
  snapshot: TaskSnapshot,
  op: string,
  input: Readonly<Record<string, unknown>>,
): NamedCommand {
  return {
    op,
    ref: snapshot.task.id,
    ifRevision: snapshot.task.revision,
    ...(snapshot.expectedVersion === undefined
      ? {}
      : { expectedVersion: snapshot.expectedVersion }),
    input,
  };
}

/**
 * Создаёт задачу без CAS содержания другой записи; Core проверяет граф и адресные связи.
 */
export function createTaskCommand(input: TaskCreateInput): NamedCommand {
  return {
    op: "task.create",
    input: {
      board: input.boardId,
      title: input.title,
      description: input.description,
      column: input.column,
      ...(input.parentId === undefined ? {} : { parent: input.parentId }),
    },
  };
}

/**
 * Готовит частичное изменение текстов под исходными guards задачи.
 * undefined означает отсутствие пользовательских изменений, а не успешную запись или проверку CAS.
 */
export function updateTaskContentCommand(
  snapshot: TaskSnapshot,
  content: TaskContentInput,
): NamedCommand | undefined {
  const original = snapshot.task.data;
  const input = {
    ...(content.title === original.title ? {} : { title: content.title }),
    ...(content.description === original.description ? {} : { description: content.description }),
  };
  if (isEmptyArray(Object.keys(input))) {
    return undefined;
  }
  return guardedTaskCommand(snapshot, "task.update", input);
}

/**
 * Готовит перенос, отправляя только изменённые board/column и исходную версию задачи.
 * undefined означает отсутствие отличий; ни чтение, ни замена guards не выполняются.
 */
export function moveTaskCommand(
  snapshot: TaskSnapshot,
  placement: TaskPlacementInput,
): NamedCommand | undefined {
  const original = snapshot.task.data;
  const input = {
    ...(placement.boardId === original.boardId ? {} : { board: placement.boardId }),
    ...(placement.column === original.column ? {} : { column: placement.column }),
  };
  if (isEmptyArray(Object.keys(input))) {
    return undefined;
  }
  return guardedTaskCommand(snapshot, "task.move", input);
}

/**
 * Готовит добавление критерия или частичное обновление его текстов под CAS задачи.
 * undefined означает неизменённый текст существующего критерия; отметку пересчитывает Core.
 */
export function editTaskCriterionCommand(
  snapshot: TaskSnapshot,
  change: TaskCriterionEditInput,
): NamedCommand | undefined {
  const { content, original } = change;
  if (change.criterionId === null) {
    return guardedTaskCommand(snapshot, "task.criterion.add", {
      title: content.title,
      summary: content.summary,
      description: content.description,
    });
  }
  const fields = {
    ...(content.title === original.title ? {} : { title: content.title }),
    ...(content.summary === original.summary ? {} : { summary: content.summary }),
    ...(content.description === original.description ? {} : { description: content.description }),
  };
  if (isEmptyArray(Object.keys(fields))) {
    return undefined;
  }
  return guardedTaskCommand(snapshot, "task.criterion.update", {
    id: change.criterionId,
    ...fields,
  });
}

/**
 * Меняет отметку на противоположную прочитанной в исходном критерии, не обновляя guards задачи.
 */
export function toggleTaskCriterionCommand(
  snapshot: TaskSnapshot,
  criterion: TaskCriterion,
): NamedCommand {
  return guardedTaskCommand(
    snapshot,
    criterion.completed ? "task.criterion.reopen" : "task.criterion.complete",
    { id: criterion.id },
  );
}

/**
 * Снимает один критерий под исходной версией его задачи; состояние строки не управляет retry.
 */
export function removeTaskCriterionCommand(
  snapshot: TaskSnapshot,
  criterionId: string,
): NamedCommand {
  return guardedTaskCommand(snapshot, "task.criterion.remove", { id: criterionId });
}

/**
 * Дописывает только title/body в независимый журнал по постоянному ID задачи, без CAS содержания.
 */
export function addTaskCommentCommand(taskId: string, comment: TaskCommentInput): NamedCommand {
  return {
    op: "task.comment.add",
    ref: taskId,
    input: { title: comment.title, body: comment.body },
  };
}

/**
 * Переводит предметное изменение связи в текущую команду Core под исходными guards задачи.
 * Заменяемый список targets вычисляется исключительно из переданного исходного снимка.
 */
export function changeTaskRelationCommand(
  snapshot: TaskSnapshot,
  change: TaskRelationInput,
): NamedCommand {
  switch (change.action) {
    case "parent.set":
      return guardedTaskCommand(snapshot, "task.parent.set", { parent: change.targetId });
    case "parent.clear":
      return guardedTaskCommand(snapshot, "task.parent.clear", {});
    case "dependency.add":
      return guardedTaskCommand(snapshot, "task.dependency.add", { target: change.targetId });
    case "dependency.remove":
      return guardedTaskCommand(snapshot, "task.dependency.remove", { target: change.targetId });
    case "related.add":
      return guardedTaskCommand(snapshot, "task.link", { target: change.targetId });
    case "related.remove":
      return guardedTaskCommand(snapshot, "task.unlink", { target: change.targetId });
    case "target.add":
      return guardedTaskCommand(snapshot, "task.update", {
        targets: [...new Set([...snapshot.task.data.targets, change.targetId])],
      });
    case "target.remove":
      return guardedTaskCommand(snapshot, "task.update", {
        targets: snapshot.task.data.targets.filter((id) => id !== change.targetId),
      });
  }
}

/**
 * Сужает значение Select до опубликованной колонки без приведения типов.
 */
export function taskColumn(value: string): TaskColumn | undefined {
  return TASK_COLUMNS.find((column) => column === value);
}
