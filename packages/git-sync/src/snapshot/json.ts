import { RelayError } from "@relay/contracts";
import { snapshotMessages } from "./snapshot.messages";

/**
 * Отказывает в чтении непроверенной формы переносимых данных со стабильным кодом.
 */
export function invalidSnapshot(): never {
  throw new RelayError("GIT_INVALID_SNAPSHOT", snapshotMessages.invalid, 4);
}

/**
 * Требует JSON-объект с обычными полями, исключая prototype-ключи.
 */
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidSnapshot();
  }
  if (
    Object.keys(value).some(
      (key) => key === "__proto__" || key === "constructor" || key === "prototype",
    )
  ) {
    return invalidSnapshot();
  }
  // Проверена обычная объектная форма результата JSON.parse или собственного кодирования.
  return value as Record<string, unknown>;
}

/**
 * Требует точный закрытый набор ключей для версионированного формата.
 */
export function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    invalidSnapshot();
  }
}

/**
 * Читает строку без нормализации, сохраняя Markdown и авторство дословно.
 */
export function text(value: unknown): string {
  if (typeof value !== "string") {
    return invalidSnapshot();
  }
  return value;
}

/**
 * Проверяет неотрицательное безопасное целое значение формата.
 */
export function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidSnapshot();
  }
  return value;
}

/**
 * Читает массив без подмены повреждённого значения пустым набором.
 */
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return invalidSnapshot();
  }
  return value;
}

/**
 * Упорядочивает только ключи объектов для сравнения DTO; это не оформление Git-файла.
 * Порядок массивов и строки сохраняются дословно, не-JSON значения отвергаются.
 */
export function canonicalJson(value: unknown): string {
  return encodeJson(value, null);
}

/**
 * Формирует JSON-файл: рекурсивный lex UTF-16, отступ два пробела и ровно один конечный LF.
 * Числоподобные ключи выводятся непосредственно, без повторной сортировки JSON.stringify.
 */
export function prettyJson(value: unknown): string {
  return encodeJson(value, "") + "\n";
}

/**
 * Сериализует JSON-значение; null вместо отступа выбирает прежнюю компактную форму DTO.
 */
function encodeJson(value: unknown, indent: string | null): string {
  const nested = indent === null ? null : indent + "  ";
  if (Array.isArray(value)) {
    return container(
      "[",
      "]",
      Array.from(value, (item) => encodeJson(item, nested)),
      indent,
    );
  }
  if (value !== null && typeof value === "object") {
    const record = object(value);
    if (
      (Object.getPrototypeOf(record) !== Object.prototype &&
        Object.getPrototypeOf(record) !== null) ||
      Object.getOwnPropertySymbols(record).length > 0
    ) {
      return invalidSnapshot();
    }
    const entries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${indent === null ? "" : " "}${encodeJson(record[key], nested)}`,
      );
    return container("{", "}", entries, indent);
  }
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value))
  ) {
    return invalidSnapshot();
  }
  return JSON.stringify(value);
}

/**
 * Обрамляет уже сериализованные элементы, сохраняя пустые массивы и объекты однострочными.
 */
function container(open: string, close: string, entries: string[], indent: string | null): string {
  if (indent === null || entries.length === 0) {
    return open + entries.join(",") + close;
  }
  const prefix = indent + "  ";
  return `${open}\n${prefix}${entries.join(",\n" + prefix)}\n${indent}${close}`;
}

/**
 * Проверяет уникальность JSON-ключей, включая одинаковые ключи с разными escape-последовательностями.
 * Вызывается после проверки грамматики JSON.parse: строки рассматриваются целыми токенами.
 */
function requireUniqueKeys(json: string): void {
  const scopes: (Set<string> | null)[] = [];
  let expectingKey = false;
  for (const match of json.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]/g)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      scopes.push(token === "{" ? new Set() : null);
      expectingKey = token === "{";
    } else if (token === "}" || token === "]") {
      scopes.pop();
      expectingKey = false;
    } else if (token === "," || token === ":") {
      expectingKey = token === ",";
    } else {
      const scope = scopes.at(-1);
      if (scope && expectingKey) {
        const key = text(JSON.parse(token));
        if (scope.has(key)) {
          invalidSnapshot();
        }
        scope.add(key);
      }
      expectingKey = false;
    }
  }
}

/**
 * Декодирует строго UTF-8 JSON без повторных ключей и нечисловых результатов переполнения.
 * BOM в JSON не допускается; строки и escape непарных surrogate сохраняются дословно.
 */
export function parseJson(bytes: Uint8Array): unknown {
  try {
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(json, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) {
        invalidSnapshot();
      }
      return item;
    });
    requireUniqueKeys(json);
    return value;
  } catch {
    return invalidSnapshot();
  }
}
