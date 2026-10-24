import type { ComponentKind } from "./component.types";
import { componentCollectionNames } from "./component.constants";
import { PLAN_SCOPE_KINDS } from "../planning/planning.constants";
import { DOCUMENT_RELATION_TYPES, DOCUMENT_TARGET_KINDS } from "../knowledge/knowledge.constants";
import { historyRunStates, historyOperatorSources } from "../history/history.constants";

/**
 * Отличает JSON-объект от массива/null; значения по-прежнему требуют проверки.
 */
export function componentObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Проверяет точный набор полей и текстовую форму части без предметной нормализации.
 */
function strings(
  value: Record<string, unknown>,
  fields: readonly string[],
  others: readonly string[] = [],
): boolean {
  return (
    fields.every((field) => typeof value[field] === "string") &&
    Object.keys(value).every((field) => fields.includes(field) || others.includes(field))
  );
}

/**
 * Проверяет переносимую техническую форму value, не заменяя предметные правила Core.
 */
export function isComponentValue(kind: ComponentKind, value: unknown): boolean {
  if (!componentObject(value)) {
    return false;
  }
  switch (kind) {
    case "collection":
      return (
        strings(value, ["field"]) && componentCollectionNames.some((field) => field === value.field)
      );
    case "task-criterion":
      return (
        strings(
          value,
          ["id", "title", "summary", "description"],
          ["completed", "completedAt", "completedBy"],
        ) &&
        typeof value.completed === "boolean" &&
        [value.completedAt, value.completedBy].every(
          (item) => item === null || typeof item === "string",
        )
      );
    case "plan-stage":
      return strings(value, ["id", "title", "summary", "outcome", "completionConditions"]);
    case "document-section":
      return strings(value, ["id", "name"]);
    case "task-dependency":
    case "task-related":
      return strings(value, ["taskId"]);
    case "task-target":
      return strings(value, ["targetId"]);
    case "plan-task":
      return strings(value, ["stageId", "taskId"]);
    case "plan-participant":
      return strings(value, ["participant"]);
    case "release-plan":
      return strings(value, ["planId"]);
    case "section-reservation":
      return strings(value, ["sectionId"]);
    case "application-participation":
      return strings(value, ["implementationId"]);
    case "address-assignment":
      return strings(value, ["ref"]);
    case "plan-scope":
      return strings(value, ["id", "kind"]) && PLAN_SCOPE_KINDS.some((kind) => kind === value.kind);
    case "document-relation":
      return (
        strings(value, ["type", "description"], ["target"]) &&
        DOCUMENT_RELATION_TYPES.some((type) => type === value.type) &&
        componentObject(value.target) &&
        strings(value.target, ["kind", "id"]) &&
        DOCUMENT_TARGET_KINDS.some(
          (kind) => componentObject(value.target) && kind === value.target.kind,
        )
      );
    case "session-run":
      return (
        strings(
          value,
          ["id", "key", "actor", "state", "startedAt"],
          [
            "reason",
            "operator",
            "client",
            "sourceSessionId",
            "predecessorRunId",
            "endedAt",
            "endReason",
          ],
        ) &&
        historyRunStates.some((state) => state === value.state) &&
        ["reason", "client", "sourceSessionId", "predecessorRunId", "endedAt", "endReason"].every(
          (field) => value[field] === null || typeof value[field] === "string",
        ) &&
        (value.operator === null ||
          (componentObject(value.operator) &&
            ["name", "email"].every(
              (field) =>
                value.operator !== null &&
                componentObject(value.operator) &&
                (value.operator[field] === null || typeof value.operator[field] === "string"),
            ) &&
            historyOperatorSources.some(
              (source) => componentObject(value.operator) && source === value.operator.source,
            )))
      );
  }
}
