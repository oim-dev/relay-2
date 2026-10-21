/** Внешний ввод истории: проверка формы и перевод в предметные значения до оркестрации. */
import {
  RelayError,
  validateActor,
  historySessionStatuses,
  historyOperatorSources,
  type HistoryCheckpointAction,
  type HistoryOperator,
  type HistorySessionStatus,
  type WriteOptions,
} from "@relay/contracts";

const connectionFields = ["client", "sourceSessionId", "reason", "operator"];

export function invalidHistoryInput(message: string): never {
  throw new RelayError("INVALID_INPUT", message, 2);
}

function object(
  value: unknown,
  allowed: readonly string[],
  label = "Ввод",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidHistoryInput(`${label}: ожидается объект.`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalidHistoryInput(`${label}: ожидается обычный объект.`);
  }
  const result = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      invalidHistoryInput(`${label}: неизвестное поле ${String(key)}.`);
    }
  }
  return result;
}

function text(value: unknown, label: string, singleLine = false): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalidHistoryInput(`${label}: требуется непустой текст.`);
  }
  if (singleLine && /[\r\n]/u.test(value)) invalidHistoryInput(`${label}: требуется одна строка.`);
  return value;
}

function optionalText(value: unknown, label: string, singleLine = false): string | null {
  return value === undefined ? null : text(value, label, singleLine);
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    invalidHistoryInput(`${label}: ожидается массив постоянных ID или ссылок.`);
  const result = Array.from(value, (item) => text(item, label, true));
  if (new Set(result).size !== result.length)
    invalidHistoryInput(`${label}: повторяющиеся значения.`);
  return result;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const match = values.find((entry) => entry === value);
  if (match === undefined) invalidHistoryInput(`${label}: неизвестное значение.`);
  return match;
}

function operator(value: unknown): HistoryOperator | null {
  if (value === null) return null;
  const input = object(value, ["name", "email", "source"], "operator");
  return {
    name: input.name === null ? null : optionalText(input.name, "operator.name", true),
    email: input.email === null ? null : optionalText(input.email, "operator.email", true),
    source: enumeration(input.source, historyOperatorSources, "operator.source"),
  };
}

export function historyWriteOptions(value: unknown): WriteOptions {
  const input = object(value, ["actor", "ifRevision"], "Параметры записи");
  const actor = validateActor(input.actor);
  if (
    typeof input.ifRevision !== "number" ||
    !Number.isSafeInteger(input.ifRevision) ||
    input.ifRevision < 1
  ) {
    invalidHistoryInput("ifRevision: требуется положительная целая ревизия сессии.");
  }
  return { actor, ifRevision: input.ifRevision };
}

export type HistoryConnection = {
  client: string | null;
  sourceSessionId: string | null;
  reason: string | null;
  /** undefined сохраняет отличие отсутствующего пользователя от явного operator: null. */
  operator: HistoryOperator | null | undefined;
};

function connection(input: Record<string, unknown>): HistoryConnection {
  return {
    client: optionalText(input.client, "client", true),
    sourceSessionId: optionalText(input.sourceSessionId, "sourceSessionId", true),
    reason: optionalText(input.reason, "reason"),
    operator: input.operator === undefined ? undefined : operator(input.operator),
  };
}

export type HistorySessionContent = { title: string; description: string | null };

function sessionContent(input: Record<string, unknown>): HistorySessionContent {
  return {
    title: text(input.title, "title", true),
    description: optionalText(input.description, "description"),
  };
}

export function historyStartInput(value: unknown): HistorySessionContent & HistoryConnection {
  const input = object(value, ["title", "description", ...connectionFields]);
  return { ...sessionContent(input), ...connection(input) };
}

export type HistoryTransition =
  | ({ action: "fork"; runId: string } & HistorySessionContent)
  | ({ action: "attach" | "resume" } & HistoryConnection)
  | ({ action: "takeover"; reason: string } & HistoryConnection)
  | { action: "pause"; runId: string; reason: string }
  | { action: "complete" | "cancel"; runId: string | null; result: string };

export function historyTransitionInput(action: string, value: unknown): HistoryTransition {
  if (action === "fork") {
    const input = object(value, ["title", "description", "runId"]);
    return { action, ...sessionContent(input), runId: text(input.runId, "runId", true) };
  }
  if (action === "attach" || action === "resume" || action === "takeover") {
    const input = object(value, connectionFields);
    const result = connection(input);
    if (action === "takeover") return { ...result, action, reason: text(input.reason, "reason") };
    return { action, ...result };
  }
  if (action === "pause") {
    const input = object(value, ["runId", "reason"]);
    return {
      action,
      runId: text(input.runId, "runId", true),
      reason: text(input.reason, "reason"),
    };
  }
  if (action === "complete" || action === "cancel") {
    const input = object(value, ["runId", "result"]);
    return {
      action,
      runId: optionalText(input.runId, "runId", true),
      result: text(input.result, "result"),
    };
  }
  invalidHistoryInput("Неизвестное действие сессии.");
}

export function historyCheckpointInput(action: HistoryCheckpointAction, value: unknown) {
  if (!["open", "save", "complete", "cancel"].includes(action)) {
    invalidHistoryInput("Неизвестное действие точки работы.");
  }
  const input = object(value, [
    "runId",
    "title",
    "body",
    "summary",
    "done",
    "remaining",
    "nextStep",
    "checks",
    "references",
    ...(action === "open" ? [] : ["acceptedSessionIds"]),
  ]);
  return {
    runId: text(input.runId, "runId", true),
    title: text(input.title, "title", true),
    body: text(input.body, "body"),
    summary: optionalText(input.summary, "summary"),
    done: optionalText(input.done, "done"),
    remaining: optionalText(input.remaining, "remaining"),
    nextStep: optionalText(input.nextStep, "nextStep"),
    checks: optionalText(input.checks, "checks"),
    references: stringArray(input.references, "references"),
    acceptedSessionIds: stringArray(input.acceptedSessionIds, "acceptedSessionIds"),
  };
}

export type HistoryFilters = {
  status: HistorySessionStatus | undefined;
  unfinished: boolean | undefined;
  parent: string | null | undefined;
  actor: string | null;
  query: string | null;
};

export function historyFilters(value: unknown): HistoryFilters {
  const input = object(value, ["status", "unfinished", "parent", "actor", "q"]);
  if (input.unfinished !== undefined && typeof input.unfinished !== "boolean") {
    invalidHistoryInput("unfinished: ожидается логическое значение.");
  }
  return {
    status:
      input.status === undefined
        ? undefined
        : enumeration(input.status, historySessionStatuses, "status"),
    unfinished: input.unfinished,
    parent:
      input.parent === undefined || input.parent === null
        ? input.parent
        : text(input.parent, "parent", true),
    actor: input.actor === undefined ? null : validateActor(input.actor),
    query: optionalText(input.q, "q")?.toLocaleLowerCase() ?? null,
  };
}
