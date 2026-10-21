/** Граница внешнего ввода планирования: после проверки сценарии работают с предметными полями. */
import {
  PLAN_SCOPE_KINDS,
  PLAN_STATUSES,
  RELEASE_STATUSES,
  RelayError,
  type PlanningKind,
  type PlanningFilter,
  type PlanScope,
  type WorkPlanFields,
  type ReleaseFields,
  type StageFields,
  type StageChange,
  type PlanTransition,
  type ReleaseTransition,
  type PlanTaskTransfer,
} from "@relay/contracts";

export const planFields = [
  "title",
  "summary",
  "goal",
  "rationale",
  "boundaries",
  "expectedResult",
  "participants",
  "scope",
] as const;
export const releaseFields = [
  "title",
  "version",
  "summary",
  "description",
  "planIds",
  "plannedFor",
] as const;
const stageFields = ["title", "summary", "outcome", "completionConditions"] as const;

export function invalid(message: string): never {
  throw new RelayError("VALIDATION_ERROR", message, 2);
}

export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("Ожидается объект полей.");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    invalid("Ожидается обычный объект полей.");
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) invalid(`Неизвестное поле: ${key}.`);
    if (result[key] === undefined) invalid(`Поле ${key} не может быть undefined.`);
  }
  return result;
}

export function text(
  value: unknown,
  field: string,
  max = 256 * 1024,
  required = false,
  line = false,
): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    invalid(`Поле ${field} должно быть строкой длиной не более ${max} без NUL.`);
  if (required && !value.trim()) invalid(`Поле ${field} не должно быть пустым.`);
  if (line && /[\r\n\u2028\u2029]/u.test(value))
    invalid(`Поле ${field} должно занимать одну строку.`);
  return value;
}

export function reference(value: unknown, field: string): string {
  return text(value, field, 256, true, true);
}

export function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid("Ожидаемая ревизия должна быть положительным целым числом.");
  return value;
}

export function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const selected = choices.find((item) => item === value);
  if (selected === undefined) invalid(`Поле ${field}: допустимы ${choices.join(", ")}.`);
  return selected;
}

export function uniqueList<T>(
  value: unknown,
  field: string,
  max: number,
  decode: (item: unknown) => T,
  key: (item: T) => string,
  min = 0,
): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid(`Поле ${field}: ожидается массив длиной от ${min} до ${max}.`);
  // Array.from посещает пропуски разреженного массива, не превращая их в сохранённый null.
  const items = Array.from(value, decode);
  if (new Set(items.map(key)).size !== items.length) invalid(`Поле ${field}: повторы недопустимы.`);
  return items;
}

export function references(value: unknown, field: string, max: number, min = 0): string[] {
  return uniqueList(
    value,
    field,
    max,
    (item) => reference(item, field),
    (item) => item,
    min,
  );
}

export function scope(value: unknown): PlanScope[] {
  return uniqueList(
    value,
    "scope",
    100,
    (item) => {
      const entry = object(item, ["kind", "id"]);
      return {
        kind: choice(entry.kind, PLAN_SCOPE_KINDS, "scope.kind"),
        id: reference(entry.id, "scope.id"),
      };
    },
    (item) => item.id,
  );
}

export function plannedFor(value: unknown): string {
  const date = text(value, "plannedFor", 10);
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  )
    invalid("plannedFor должен быть календарной датой YYYY-MM-DD либо пустой строкой.");
  return date;
}

export function parsePlanFields(input: unknown): Partial<WorkPlanFields> {
  const fields = object(input, planFields);
  const result: Partial<WorkPlanFields> = {};
  if (Object.hasOwn(fields, "title")) result.title = text(fields.title, "title", 160, true, true);
  for (const field of ["summary", "goal", "rationale", "boundaries", "expectedResult"] as const)
    if (Object.hasOwn(fields, field))
      result[field] = text(fields[field], field, field === "summary" ? 16 * 1024 : 256 * 1024);
  if (Object.hasOwn(fields, "participants"))
    result.participants = uniqueList(
      fields.participants,
      "participants",
      100,
      (item) => text(item, "participants", 160, true, true),
      (item) => item,
    );
  if (Object.hasOwn(fields, "scope")) result.scope = scope(fields.scope);
  return result;
}

export function parseReleaseFields(input: unknown): Partial<ReleaseFields> {
  const fields = object(input, releaseFields);
  const result: Partial<ReleaseFields> = {};
  if (Object.hasOwn(fields, "title")) result.title = text(fields.title, "title", 160, true, true);
  if (Object.hasOwn(fields, "version"))
    result.version = text(fields.version, "version", 80, true, true);
  if (Object.hasOwn(fields, "summary")) result.summary = text(fields.summary, "summary", 16 * 1024);
  if (Object.hasOwn(fields, "description"))
    result.description = text(fields.description, "description");
  if (Object.hasOwn(fields, "planIds"))
    result.planIds = references(fields.planIds, "planIds", 200, 1);
  if (Object.hasOwn(fields, "plannedFor")) result.plannedFor = plannedFor(fields.plannedFor);
  return result;
}

function parseStageFields(fields: Record<string, unknown>): Partial<StageFields> {
  const result: Partial<StageFields> = {};
  if (Object.hasOwn(fields, "title")) result.title = text(fields.title, "title", 160, true, true);
  if (Object.hasOwn(fields, "summary")) result.summary = text(fields.summary, "summary", 16 * 1024);
  if (Object.hasOwn(fields, "outcome")) result.outcome = text(fields.outcome, "outcome");
  if (Object.hasOwn(fields, "completionConditions"))
    result.completionConditions = text(fields.completionConditions, "completionConditions");
  return result;
}

export function parseStageChange(action: string, input: unknown): StageChange {
  if (action === "create") {
    const value = object(input, [...stageFields, "before"]);
    const fields = parseStageFields(value);
    if (fields.title === undefined) invalid("Передайте заголовок этапа.");
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
  const value = object(
    input,
    operation === "update"
      ? ["stageId", ...stageFields]
      : operation === "move"
        ? ["stageId", "before", "direction"]
        : ["stageId"],
  );
  const stageId = reference(value.stageId, "stageId");
  if (operation === "remove") return { action: operation, stageId };
  if (operation === "update") {
    const fields = parseStageFields(value);
    if (!Object.keys(fields).length) invalid("Передайте хотя бы одно поле этапа.");
    return { action: operation, stageId, fields };
  }
  if (Object.hasOwn(value, "before") === Object.hasOwn(value, "direction"))
    invalid("Для перемещения передайте ровно одно поле: before или direction.");
  const destination = Object.hasOwn(value, "direction")
    ? { direction: choice(value.direction, ["up", "down"] as const, "direction") }
    : { before: value.before === null ? null : reference(value.before, "before") };
  return { action: operation, stageId, destination };
}

export function parsePlanTransition(action: string, input: unknown): PlanTransition {
  const operation = choice(action, ["start", "complete", "cancel"] as const, "action");
  const fields = object(input, operation === "start" ? [] : ["result"]);
  return operation === "start"
    ? { action: operation }
    : { action: operation, result: text(fields.result, "result", 256 * 1024, true) };
}

export function parseReleaseTransition(action: string, input: unknown): ReleaseTransition {
  const operation = choice(action, ["plan", "cancel", "publish"] as const, "action");
  object(input, []);
  return operation;
}

export function parseTransfer(input: unknown): PlanTaskTransfer {
  const fields = object(input, ["task", "targetPlan", "targetStage", "reason"]);
  return {
    task: reference(fields.task, "task"),
    targetPlan: reference(fields.targetPlan, "targetPlan"),
    targetStage: reference(fields.targetStage, "targetStage"),
    reason: text(fields.reason, "reason", 16 * 1024, true),
  };
}

export function planningKind(value: unknown): PlanningKind {
  return choice(value, ["work-plan", "release"] as const, "kind");
}

export function parsePlanningFilter(kind: PlanningKind, input: unknown): PlanningFilter {
  try {
    const fields = object(input, ["q", "status"]);
    return {
      ...(Object.hasOwn(fields, "q") ? { q: text(fields.q, "q", 256 * 1024, true) } : {}),
      ...(Object.hasOwn(fields, "status")
        ? {
            status:
              kind === "work-plan"
                ? choice(fields.status, PLAN_STATUSES, "status")
                : choice(fields.status, RELEASE_STATUSES, "status"),
          }
        : {}),
    };
  } catch (error) {
    if (!(error instanceof RelayError) || error.code !== "VALIDATION_ERROR") throw error;
    throw new RelayError("INVALID_ARGUMENT", error.message, 2);
  }
}
