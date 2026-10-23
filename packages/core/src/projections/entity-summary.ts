import {
  DOCUMENT_STATUSES,
  IMPLEMENTATION_STATUSES,
  PLAN_STATUSES,
  RELEASE_STATUSES,
  RelayError,
  TASK_COLUMNS,
  historySessionStatuses,
  isProjectName,
  type EntitySummary,
} from "@relay/contracts";
import type { EntitySummaryProjection } from "@relay/storage";
import { HISTORY_TITLE_RULES, historyTextViolation } from "../history/history-text";
import { isKnowledgeTitle } from "../knowledge/knowledge-title";
import { planningTitle } from "../planning/planning-validation";
import { isTaskTitle } from "../tasks/task-text";
import { entitySummaryMessages } from "./entity-summary.messages";

/**
 * Отклоняет повреждённое поле краткой проекции, сохраняя идентичность исходной записи.
 */
function corruptSummary(record: EntitySummaryProjection, field: string, cause?: Error): never {
  const error = new RelayError(
    "CORRUPT_DATA",
    entitySummaryMessages.invalidField(record.key, field),
    1,
    {
      id: record.id,
      kind: record.kind,
      field,
    },
  );
  if (cause !== undefined) {
    error.cause = cause;
  }
  throw error;
}

/**
 * Проверяет только выбранное название чистым правилом предметного владельца.
 * Различия допустимого Unicode, длины и пустоты сохраняются; полное содержание не требуется.
 * Отсутствующее имя seed-продукта проецируется в ключ, остальные повреждения дают CORRUPT_DATA.
 */
function readSummaryTitle(record: EntitySummaryProjection): string {
  const title = record.kind === "product" && record.title === undefined ? record.key : record.title;
  if (typeof title !== "string") {
    corruptSummary(record, "title");
  }
  let valid: boolean;
  switch (record.kind) {
    case "project":
      valid = isProjectName(title);
      break;
    case "task":
      valid = isTaskTitle(title);
      break;
    case "work-session":
    case "work-checkpoint":
      valid = historyTextViolation(title, HISTORY_TITLE_RULES) === undefined;
      break;
    case "work-plan":
    case "release":
      try {
        return planningTitle(title);
      } catch (error) {
        if (error instanceof RelayError && error.code === "VALIDATION_ERROR") {
          corruptSummary(record, "title", error);
        }
        throw error;
      }
    default:
      valid = isKnowledgeTitle(title);
  }
  if (!valid) {
    corruptSummary(record, "title");
  }
  return title;
}

/**
 * Декодирует только выбранное сохранённое состояние, не вычисляя прогресс и не читая связи.
 */
function summaryState<State extends string>(
  record: EntitySummaryProjection,
  variants: readonly State[],
  field = "status",
): State {
  const state = variants.find((variant) => variant === record.state);
  if (state === undefined) {
    corruptSummary(record, field);
  }
  return state;
}

/**
 * Проверяет узкую SQL-проекцию и возвращает переносимую карточку без data и вложенных составов.
 * Проверяются только выбранные поля; полная предметная проверка принадлежит EntityReader.
 * Отсутствующее имя seed-продукта показывается ключом, явное null и неверные значения — CORRUPT_DATA.
 * Пустые и пробельные заголовки задач сохраняются дословно по правилам владельца задач.
 */
export function decodeEntitySummary(record: EntitySummaryProjection): EntitySummary {
  for (const field of ["id", "key"] as const) {
    const value = record[field];
    if (!value || value !== value.trim() || /[\p{Cc}\u2028\u2029]/u.test(value)) {
      corruptSummary(record, field);
    }
  }
  if (/[\s:]/u.test(record.key)) {
    corruptSummary(record, "key");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    corruptSummary(record, "revision");
  }
  const title = readSummaryTitle(record);
  const identity = { id: record.id, key: record.key, revision: record.revision, title };
  const kind = record.kind;
  switch (kind) {
    case "task":
      return { ...identity, kind, state: summaryState(record, TASK_COLUMNS, "column") };
    case "document":
      return {
        ...identity,
        kind,
        state: summaryState(record, DOCUMENT_STATUSES, "documentStatus"),
      };
    case "work-plan":
      return { ...identity, kind, state: summaryState(record, PLAN_STATUSES) };
    case "release":
      return { ...identity, kind, state: summaryState(record, RELEASE_STATUSES) };
    case "work-session":
      return { ...identity, kind, state: summaryState(record, historySessionStatuses) };
    case "implementation": {
      if (typeof record.active !== "boolean") {
        corruptSummary(record, "active");
      }
      return {
        ...identity,
        kind,
        state: summaryState(record, IMPLEMENTATION_STATUSES),
        active: record.active,
      };
    }
    default:
      return { ...identity, kind };
  }
}
