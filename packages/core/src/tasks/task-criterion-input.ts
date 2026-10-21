/**
 * Декодирование команд критерия; состояние задачи и сам критерий проверяют чистые правила.
 */
import { TASK_CRITERION_ACTIONS, TASK_CRITERION_FIELDS } from "./task-constants";
import { choice, criterionText, invalid, newCriterion, object, reference } from "./task-input";
import type { TaskCriterionChange, TaskCriterionContent } from "./task-input.types";
import { taskLabels, taskMessages } from "./task-messages";

/**
 * Проверяет непустую частичную правку текстов, не подставляя содержание сохранённого критерия.
 */
function parseCriterionFields(
  value: Readonly<Record<string, unknown>>,
): Partial<TaskCriterionContent> {
  if (!TASK_CRITERION_FIELDS.some((field) => value[field] !== undefined)) {
    invalid(taskMessages.emptyCriterionUpdate);
  }
  return {
    ...(value.title === undefined
      ? {}
      : {
          title: criterionText(value.title, "title"),
        }),
    ...(value.summary === undefined
      ? {}
      : {
          summary: criterionText(value.summary, "summary"),
        }),
    ...(value.description === undefined
      ? {}
      : {
          description: criterionText(value.description, "description"),
        }),
  };
}

/**
 * Связывает действие с проверенной формой команды; добавление выделяет новый UUID критерия.
 */
export function parseTaskCriterionChange(action: unknown, input: unknown): TaskCriterionChange {
  const operation = choice(action, TASK_CRITERION_ACTIONS, taskLabels.criterionAction);
  if (operation === "add") {
    const value = object(input, TASK_CRITERION_FIELDS, taskLabels.criterionChange);
    return { action: operation, criterion: newCriterion(value) };
  }
  const fields: readonly string[] =
    operation === "update"
      ? ["id", "criterionId", ...TASK_CRITERION_FIELDS]
      : ["id", "criterionId"];
  const value = object(input, fields, taskLabels.criterionChange);
  if (value.id !== undefined && value.criterionId !== undefined) {
    invalid(taskMessages.criterionAliases);
  }
  const criterionId = reference(value.id ?? value.criterionId, taskLabels.criterionId);
  if (operation === "update") {
    return { action: operation, criterionId, fields: parseCriterionFields(value) };
  }
  return { action: operation, criterionId };
}
