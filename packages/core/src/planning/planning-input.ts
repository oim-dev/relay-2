/**
 * Граница внешнего ввода планирования: после проверки сценарии получают предметные поля.
 * Разрешённые поля зависят от команды; общими проверками значений владеет planning-validation.
 */
import {
  PLAN_STATUSES,
  RELEASE_STATUSES,
  RelayError,
  type PlanningKind,
  type PlanningFilter,
  type WorkPlanFields,
  type ReleaseFields,
  type StageFields,
  type StageChange,
  type PlanTransition,
  type ReleaseTransition,
  type PlanTaskTransfer,
} from "@relay/contracts";
import { planFields, planningLimits, releaseFields, stageFields } from "./planning.constants";
import { planningMessages } from "./planning.messages";
import type { ParsedPlanningFilter } from "./planning-input.types";
import {
  choice,
  invalid,
  object,
  participants,
  plannedFor,
  planningTitle,
  reference,
  references,
  scope,
  text,
  uniqueList,
} from "./planning-validation";

export { planFields, releaseFields } from "./planning.constants";
export {
  choice,
  invalid,
  object,
  plannedFor,
  reference,
  references,
  revision,
  scope,
  text,
  uniqueList,
} from "./planning-validation";

/**
 * Проверяет разрешённые поля плана, сохраняя отсутствие необязательных свойств.
 * Область воздействия пока содержит пользовательские ссылки; записи не читаются.
 */
export function parsePlanFields(input: unknown): Partial<WorkPlanFields> {
  const fields = object(input, planFields);
  const result: Partial<WorkPlanFields> = {};
  if (Object.hasOwn(fields, "title")) {
    result.title = planningTitle(fields.title);
  }
  for (const field of ["summary", "goal", "rationale", "boundaries", "expectedResult"] as const) {
    if (Object.hasOwn(fields, field)) {
      result[field] = text(fields[field], field, {
        maxLength: field === "summary" ? planningLimits.summaryLength : planningLimits.textLength,
      });
    }
  }
  if (Object.hasOwn(fields, "participants")) {
    result.participants = participants(fields.participants);
  }
  if (Object.hasOwn(fields, "scope")) {
    result.scope = scope(fields.scope);
  }
  return result;
}

/**
 * Проверяет вход команды до async адресации. CLI допускает строковую ссылку scope;
 * строгий parsePlanFields по-прежнему принимает только предметные объекты {kind,id}.
 * Пропуски массивов, неизвестные поля и undefined не теряются при упаковке single-команды.
 */
export function parsePlanCommandInput(input: unknown): Readonly<Record<string, unknown>> {
  const value = object(input, planFields);
  const { scope: entries, ...fields } = value;
  const parsed = parsePlanFields(fields);
  if (!Object.hasOwn(value, "scope")) {
    return { ...parsed };
  }
  const checked = uniqueList(
    entries,
    "scope",
    planningLimits.scopeEntries,
    (entry) => {
      if (typeof entry === "string") {
        return reference(entry, "scope");
      }
      const [target] = scope([entry]);
      if (target === undefined) {
        invalid(planningMessages.missingScope);
      }
      return target;
    },
    (entry) => (typeof entry === "string" ? entry : entry.id),
  );
  return { ...parsed, scope: checked };
}

/**
 * Проверяет содержание релиза; состав остаётся набором пользовательских ссылок до подготовки.
 */
export function parseReleaseFields(input: unknown): Partial<ReleaseFields> {
  const fields = object(input, releaseFields);
  const result: Partial<ReleaseFields> = {};
  if (Object.hasOwn(fields, "title")) {
    result.title = planningTitle(fields.title);
  }
  if (Object.hasOwn(fields, "version")) {
    result.version = text(fields.version, "version", {
      maxLength: planningLimits.versionLength,
      required: true,
      singleLine: true,
    });
  }
  if (Object.hasOwn(fields, "summary")) {
    result.summary = text(fields.summary, "summary", { maxLength: planningLimits.summaryLength });
  }
  if (Object.hasOwn(fields, "description")) {
    result.description = text(fields.description, "description");
  }
  if (Object.hasOwn(fields, "planIds")) {
    result.planIds = references(
      fields.planIds,
      "planIds",
      planningLimits.releasePlans,
      planningLimits.minimumReleasePlans,
    );
  }
  if (Object.hasOwn(fields, "plannedFor")) {
    result.plannedFor = plannedFor(fields.plannedFor);
  }
  return result;
}

/**
 * Декодирует текстовые поля из уже проверенного объекта команды этапа.
 */
function parseStageFields(fields: Readonly<Record<string, unknown>>): Partial<StageFields> {
  const result: Partial<StageFields> = {};
  if (Object.hasOwn(fields, "title")) {
    result.title = planningTitle(fields.title);
  }
  if (Object.hasOwn(fields, "summary")) {
    result.summary = text(fields.summary, "summary", { maxLength: planningLimits.summaryLength });
  }
  if (Object.hasOwn(fields, "outcome")) {
    result.outcome = text(fields.outcome, "outcome");
  }
  if (Object.hasOwn(fields, "completionConditions")) {
    result.completionConditions = text(fields.completionConditions, "completionConditions");
  }
  return result;
}

/**
 * Проверяет команду изменения этапа; создание задаёт пустые необязательные тексты.
 * Перемещение требует ровно один способ назначения позиции, null означает конец списка.
 */
export function parseStageChange(action: string, input: unknown): StageChange {
  if (action === "create") {
    const value = object(input, [...stageFields, "before"]);
    const fields = parseStageFields(value);
    if (fields.title === undefined) {
      invalid(planningMessages.missingStageTitle);
    }
    return {
      action,
      fields: {
        summary: "",
        outcome: "",
        completionConditions: "",
        ...fields,
        title: fields.title,
      },
      before: value.before == null ? null : reference(value.before, "before"),
    };
  }
  const operation = choice(action, ["update", "remove", "move"] as const, "action");
  const fieldsByOperation = {
    update: ["stageId", ...stageFields],
    move: ["stageId", "before", "direction"],
    remove: ["stageId"],
  } as const;
  const value = object(input, fieldsByOperation[operation]);
  const stageId = reference(value.stageId, "stageId");
  if (operation === "remove") {
    return { action: operation, stageId };
  }
  if (operation === "update") {
    const fields = parseStageFields(value);
    if (!Object.keys(fields).length) {
      invalid(planningMessages.emptyStageUpdate);
    }
    return { action: operation, stageId, fields };
  }
  if (Object.hasOwn(value, "before") === Object.hasOwn(value, "direction")) {
    invalid(planningMessages.invalidStageDestination);
  }
  if (Object.hasOwn(value, "direction")) {
    return {
      action: operation,
      stageId,
      destination: { direction: choice(value.direction, ["up", "down"] as const, "direction") },
    };
  }
  return {
    action: operation,
    stageId,
    destination: { before: value.before === null ? null : reference(value.before, "before") },
  };
}

/**
 * Проверяет действие над планом; завершение и отмена требуют непустого результата.
 */
export function parsePlanTransition(action: string, input: unknown): PlanTransition {
  const operation = choice(action, ["start", "complete", "cancel"] as const, "action");
  const fields = object(input, operation === "start" ? [] : ["result"]);
  return operation === "start"
    ? { action: operation }
    : { action: operation, result: text(fields.result, "result", { required: true }) };
}

/**
 * Проверяет действие над релизом и отсутствие дополнительных полей.
 */
export function parseReleaseTransition(action: string, input: unknown): ReleaseTransition {
  const operation = choice(action, ["plan", "cancel", "publish"] as const, "action");
  object(input, []);
  return operation;
}

/**
 * Проверяет ссылки и обязательное обоснование явного переноса без чтения связанных записей.
 */
export function parseTransfer(input: unknown): PlanTaskTransfer {
  const fields = object(input, ["task", "targetPlan", "targetStage", "reason"]);
  return {
    task: reference(fields.task, "task"),
    targetPlan: reference(fields.targetPlan, "targetPlan"),
    targetStage: reference(fields.targetStage, "targetStage"),
    reason: text(fields.reason, "reason", {
      maxLength: planningLimits.transferReasonLength,
      required: true,
    }),
  };
}

/**
 * Ограничивает внешний вид сущности двумя поддерживаемыми видами планирования.
 */
export function planningKind(value: unknown): PlanningKind {
  return choice(value, ["work-plan", "release"] as const, "kind");
}

/**
 * Проверяет поисковый фильтр и статус выбранного вида до чтения записей.
 * Ошибки формы возвращаются как INVALID_ARGUMENT с исходной причиной в cause.
 */
export function parsePlanningFilter(kind: PlanningKind, input: unknown): PlanningFilter {
  try {
    const fields = object(input, ["q", "status"]);
    const result: ParsedPlanningFilter = {};
    if (Object.hasOwn(fields, "q")) {
      result.q = text(fields.q, "q", { maxLength: planningLimits.searchLength, required: true });
    }
    if (Object.hasOwn(fields, "status")) {
      result.status =
        kind === "work-plan"
          ? choice(fields.status, PLAN_STATUSES, "status")
          : choice(fields.status, RELEASE_STATUSES, "status");
    }
    return result;
  } catch (error) {
    if (!(error instanceof RelayError) || error.code !== "VALIDATION_ERROR") {
      throw error;
    }
    const failure = new RelayError("INVALID_ARGUMENT", error.message, 2);
    failure.cause = error;
    throw failure;
  }
}
