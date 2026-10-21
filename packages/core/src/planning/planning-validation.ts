/**
 * Проверка отдельных значений планирования для внешнего ввода и сохранённого JSON.
 * Не разрешает ссылки и не определяет разрешённые поля конкретной команды.
 */
import { PLAN_SCOPE_KINDS, RelayError, type PlanScope } from "@relay/contracts";
import { planningLimits } from "./planning.constants";
import { planningMessages } from "./planning.messages";
import type { PlanningTextRules } from "./planning-input.types";

/**
 * Отклоняет внешние поля с предметным кодом ошибки валидации.
 */
export function invalid(message: string): never {
  throw new RelayError("VALIDATION_ERROR", message, 2);
}

/**
 * Сужает внешний объект до словаря ещё не проверенных значений.
 */
function isFieldObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Проверяет обычный объект с разрешёнными ключами без изменения входа.
 * Неизвестные ключи и явно переданный undefined запрещены; обязательность проверяет парсер поля.
 */
export function object(
  value: unknown,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isFieldObject(value)) {
    invalid(planningMessages.expectedObject);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid(planningMessages.expectedPlainObject);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      invalid(planningMessages.unknownField(key));
    }
    if (value[key] === undefined) {
      invalid(planningMessages.undefinedField(key));
    }
  }
  return value;
}

/**
 * Проверяет текст без нормализации пробелов и переводов строк.
 * NUL запрещён всегда; требования непустоты и одной строки задаются именованными настройками.
 */
export function text(value: unknown, field: string, rules: PlanningTextRules = {}): string {
  const maximum = rules.maxLength ?? planningLimits.textLength;
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    invalid(planningMessages.invalidText(field, maximum));
  }
  if (rules.required && !value.trim()) {
    invalid(planningMessages.emptyText(field));
  }
  if (rules.singleLine && /[\r\n\u2028\u2029]/u.test(value)) {
    invalid(planningMessages.multilineText(field));
  }
  return value;
}

/**
 * Проверяет непустую однострочную ссылку; разрешение ключа или алиаса принадлежит EntityService.
 */
export function reference(value: unknown, field: string): string {
  return text(value, field, {
    maxLength: planningLimits.referenceLength,
    required: true,
    singleLine: true,
  });
}

/**
 * Принимает только положительную безопасную целую ревизию владельца записи.
 */
export function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalid(planningMessages.invalidRevision);
  }
  return value;
}

/**
 * Проверяет принадлежность строковому предметному перечислению без приведения типов.
 */
export function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const selected = choices.find((item) => item === value);
  if (selected === undefined) {
    invalid(planningMessages.invalidChoice(field, choices));
  }
  return selected;
}

/**
 * Создаёт проверенный список заданной длины с уникальными предметными ключами.
 * Декодер посещает каждую позицию, поэтому пропуски разреженного массива также проверяются.
 */
export function uniqueList<T>(
  value: unknown,
  field: string,
  max: number,
  decode: (item: unknown) => T,
  key: (item: T) => string,
  min = 0,
): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    invalid(planningMessages.invalidList(field, min, max));
  }
  // Array.from посещает пропуски разреженного массива, не превращая их в сохранённый null.
  const items = Array.from(value, decode);
  if (new Set(items.map(key)).size !== items.length) {
    invalid(planningMessages.duplicateListItem(field));
  }
  return items;
}

/**
 * Проверяет список уникальных строковых ссылок; алиасы одной сущности различает разрешение ID.
 */
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

/**
 * Проверяет область воздействия без разрешения ссылок и сохраняет её порядок.
 */
export function scope(value: unknown): PlanScope[] {
  return uniqueList(
    value,
    "scope",
    planningLimits.scopeEntries,
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

/**
 * Принимает существующую календарную дату YYYY-MM-DD или пустую строку без срока выпуска.
 */
export function plannedFor(value: unknown): string {
  const date = text(value, "plannedFor", { maxLength: planningLimits.calendarDateLength });
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, planningLimits.calendarDateLength) !== date)
  ) {
    invalid(planningMessages.invalidPlannedFor);
  }
  return date;
}

/**
 * Проверяет упорядоченный список уникальных имён участников без нормализации текста.
 */
export function participants(value: unknown): string[] {
  return uniqueList(
    value,
    "participants",
    planningLimits.participants,
    (item) =>
      text(item, "participants", {
        maxLength: planningLimits.participantLength,
        required: true,
        singleLine: true,
      }),
    (item) => item,
  );
}
