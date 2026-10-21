/**
 * Внешний ввод истории: проверка формы и перевод в предметные значения до оркестрации.
 */
import {
  RelayError,
  validateActor,
  historySessionStatuses,
  historyOperatorSources,
  type HistoryCheckpointAction,
  type HistoryOperator,
  type WriteOptions,
} from "@relay/contracts";
import type {
  HistoryCheckpointValues,
  HistoryConnection,
  HistoryFilters,
  HistorySessionContent,
  HistoryStartValues,
  HistoryTextOptions,
  HistoryTransition,
} from "./history-input.types";
import { historyInputMessages } from "./history-messages";

export type {
  HistoryConnection,
  HistoryFilters,
  HistorySessionContent,
  HistoryTransition,
} from "./history-input.types";

const connectionFields = ["client", "sourceSessionId", "reason", "operator"] as const;

/**
 * Отклоняет неверный ввод истории с предметным кодом и кодом завершения CLI.
 */
export function invalidHistoryInput(message: string): never {
  throw new RelayError("INVALID_INPUT", message, 2);
}

/**
 * Принимает обычный объект только с разрешёнными собственными полями.
 */
function object(
  value: unknown,
  allowed: readonly string[],
  label: string = historyInputMessages.inputLabel,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidHistoryInput(historyInputMessages.objectRequired(label));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalidHistoryInput(historyInputMessages.plainObjectRequired(label));
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      invalidHistoryInput(historyInputMessages.unknownField(label, key));
    }
  }
  // Проверена форма словаря; каждое значение ниже проверяет предметный декодер поля.
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Проверяет непустой текст и ограничения строк, сохраняя пробелы и переводы строк дословно.
 */
function text(value: unknown, label: string, options: HistoryTextOptions = {}): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalidHistoryInput(historyInputMessages.textRequired(label));
  }
  if (options.singleLine && /[\r\n]/u.test(value)) {
    invalidHistoryInput(historyInputMessages.singleLineRequired(label));
  }
  return value;
}

/**
 * Переводит отсутствующее поле в null, не принимая явно переданный null вместо текста.
 */
function optionalText(
  value: unknown,
  label: string,
  options: HistoryTextOptions = {},
): string | null {
  return value === undefined ? null : text(value, label, options);
}

/**
 * Проверяет уникальные непустые адреса; пропуск поля означает пустой список.
 */
function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    invalidHistoryInput(historyInputMessages.referencesArrayRequired(label));
  }
  const result = Array.from(value, (item) => text(item, label, { singleLine: true }));
  if (new Set(result).size !== result.length) {
    invalidHistoryInput(historyInputMessages.duplicateValues(label));
  }
  return result;
}

/**
 * Выбирает допустимое значение без приведения неизвестного ввода к предметному типу.
 */
function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const match = values.find((entry) => entry === value);
  if (match === undefined) {
    invalidHistoryInput(historyInputMessages.unknownValue(label));
  }
  return match;
}

/**
 * Проверяет сведения о пользователе; явный null запрещает наследование при attach.
 */
function operator(value: unknown): HistoryOperator | null {
  if (value === null) {
    return null;
  }
  const input = object(value, ["name", "email", "source"], "operator");
  return {
    name:
      input.name === null ? null : optionalText(input.name, "operator.name", { singleLine: true }),
    email:
      input.email === null
        ? null
        : optionalText(input.email, "operator.email", { singleLine: true }),
    source: enumeration(input.source, historyOperatorSources, "operator.source"),
  };
}

/**
 * Проверяет автора общим правилом и положительную ожидаемую ревизию именно сессии.
 */
export function historyWriteOptions(value: unknown): WriteOptions {
  const input = object(value, ["actor", "ifRevision"], historyInputMessages.writeOptionsLabel);
  const actor = validateActor(input.actor);
  if (
    typeof input.ifRevision !== "number" ||
    !Number.isSafeInteger(input.ifRevision) ||
    input.ifRevision < 1
  ) {
    invalidHistoryInput(historyInputMessages.revisionRequired);
  }
  return { actor, ifRevision: input.ifRevision };
}

/**
 * Проверяет поля подключения, сохраняя различие отсутствующего operator и явного null.
 */
function connection(input: Readonly<Record<string, unknown>>): HistoryConnection {
  return {
    client: optionalText(input.client, "client", { singleLine: true }),
    sourceSessionId: optionalText(input.sourceSessionId, "sourceSessionId", { singleLine: true }),
    reason: optionalText(input.reason, "reason"),
    operator: input.operator === undefined ? undefined : operator(input.operator),
  };
}

/**
 * Проверяет заголовок и необязательное описание поручения без изменения содержания.
 */
function sessionContent(input: Readonly<Record<string, unknown>>): HistorySessionContent {
  return {
    title: text(input.title, "title", { singleLine: true }),
    description: optionalText(input.description, "description"),
  };
}

/**
 * Проверяет содержание корневой сессии и параметры её первого участия.
 */
export function historyStartInput(value: unknown): HistoryStartValues {
  const input = object(value, ["title", "description", ...connectionFields]);
  return { ...sessionContent(input), ...connection(input) };
}

/**
 * Разбирает переход в связанный с действием контракт; лишние поля отклоняются до чтения БД.
 */
export function historyTransitionInput(action: string, value: unknown): HistoryTransition {
  if (action === "fork") {
    const input = object(value, ["title", "description", "runId"]);
    return {
      action,
      ...sessionContent(input),
      runId: text(input.runId, "runId", { singleLine: true }),
    };
  }
  if (action === "attach" || action === "resume" || action === "takeover") {
    const input = object(value, connectionFields);
    const result = connection(input);
    if (action === "takeover") {
      return { ...result, action, reason: text(input.reason, "reason") };
    }
    return { action, ...result };
  }
  if (action === "pause") {
    const input = object(value, ["runId", "reason"]);
    return {
      action,
      runId: text(input.runId, "runId", { singleLine: true }),
      reason: text(input.reason, "reason"),
    };
  }
  if (action === "complete" || action === "cancel") {
    const input = object(value, ["runId", "result"]);
    return {
      action,
      runId: optionalText(input.runId, "runId", { singleLine: true }),
      result: text(input.result, "result"),
    };
  }
  invalidHistoryInput(historyInputMessages.unknownSessionAction);
}

/**
 * Проверяет материал; принятие детей недоступно для открытия нового намерения.
 * Адреса целей и принадлежность принимаемых детей проверяются позже в транзакции.
 */
export function historyCheckpointInput(
  action: HistoryCheckpointAction,
  value: unknown,
): HistoryCheckpointValues {
  if (!["open", "save", "complete", "cancel"].includes(action)) {
    invalidHistoryInput(historyInputMessages.unknownCheckpointAction);
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
    runId: text(input.runId, "runId", { singleLine: true }),
    title: text(input.title, "title", { singleLine: true }),
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

/**
 * Проверяет фильтры; ссылка родителя разрешается в том же снимке, что и список сессий.
 */
export function historyFilters(value: unknown): HistoryFilters {
  const input = object(value, ["status", "unfinished", "parent", "actor", "q"]);
  if (input.unfinished !== undefined && typeof input.unfinished !== "boolean") {
    invalidHistoryInput(historyInputMessages.unfinishedBooleanRequired);
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
        : text(input.parent, "parent", { singleLine: true }),
    actor: input.actor === undefined ? null : validateActor(input.actor),
    query: optionalText(input.q, "q")?.toLocaleLowerCase() ?? null,
  };
}
