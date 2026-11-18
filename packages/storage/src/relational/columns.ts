import { isPortableIdentityText, RelayError } from "@relay/contracts";
import type { ColumnDefinition, SqlRow, SqlScalar } from "./columns.types";
import { relationalMessages } from "./relational.messages";

/**
 * Сообщает точное место нарушения физического контракта без исправления исходных данных.
 */
export function invalidRow(field: string): never {
  throw new RelayError("CORRUPT_DATA", relationalMessages.shape, 1, { field });
}

/**
 * Проверяет объект на границе codec; значения полей пока остаются неизвестными.
 */
export function rowObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidRow(field);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Проверяет plain SQL TEXT до UTF-8 binding; исходный текст не нормализуется.
 */
export function identityText(value: unknown, field: string): string {
  if (typeof value !== "string" || !isPortableIdentityText(value)) {
    return invalidRow(field);
  }
  return value;
}

/**
 * Читает известный путь DTO, не принимая пользовательские SQL/JSON выражения.
 */
function fieldValue(data: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = data;
  for (const field of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[field];
  }
  return current;
}

/**
 * Сохраняет один пользовательский текст в единственном lossless слоте; null означает отсутствие.
 */
export function encodeText(value: string | null, column: string): SqlRow {
  if (value === null || isPortableIdentityText(value)) {
    return { [column]: value, [`${column}_json`]: null };
  }
  return { [column]: null, [`${column}_json`]: JSON.stringify(value) };
}

/**
 * Восстанавливает единственный scalar text carrier; двойное или повреждённое содержание отвергается.
 */
export function decodeText(row: Readonly<SqlRow>, column: string): string | null {
  const plain = row[column];
  const carrier = row[`${column}_json`];
  if (carrier === null) {
    return plain === null ? null : identityText(plain, column);
  }
  if (plain !== null || typeof carrier !== "string") {
    return invalidRow(column);
  }
  let value: unknown;
  try {
    value = JSON.parse(carrier);
  } catch {
    return invalidRow(column);
  }
  if (typeof value !== "string" || isPortableIdentityText(value)) {
    return invalidRow(column);
  }
  return value;
}

/**
 * Преобразует только перечисленные скаляры DTO; неизвестные поля проверяет владелец формы.
 */
export function encodeColumns(
  definitions: readonly ColumnDefinition[],
  data: Readonly<Record<string, unknown>>,
): SqlRow {
  const row: SqlRow = {};
  for (const definition of definitions) {
    let value = fieldValue(data, definition.field);
    const absent = value === undefined && definition.optional;
    if (absent) {
      value = null;
    }
    if (value === null) {
      if (!definition.nullable && !absent) {
        invalidRow(definition.field);
      }
      Object.assign(
        row,
        definition.storage === "text"
          ? encodeText(null, definition.column)
          : {
              [definition.column]: null,
            },
      );
      continue;
    }
    switch (definition.storage) {
      case "text":
        if (typeof value !== "string") {
          invalidRow(definition.field);
        }
        Object.assign(row, encodeText(value, definition.column));
        break;
      case "string": {
        const text = identityText(value, definition.field);
        if (definition.values && !definition.values.includes(text)) {
          invalidRow(definition.field);
        }
        row[definition.column] = text;
        break;
      }
      case "boolean":
        if (typeof value !== "boolean") {
          invalidRow(definition.field);
        }
        row[definition.column] = value ? 1 : 0;
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          invalidRow(definition.field);
        }
        row[definition.column] = value;
        break;
    }
  }
  return row;
}

/**
 * Записывает известный путь DTO в новый объект; не меняет исходную SQL-строку.
 */
function assignField(data: Record<string, unknown>, path: string, value: unknown): void {
  const fields = path.split(".");
  let current = data;
  for (const field of fields.slice(0, -1)) {
    const next = current[field];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      current[field] = created;
      current = created;
    } else {
      current = rowObject(next, path) as Record<string, unknown>;
    }
  }
  const last = fields.at(-1);
  if (last === undefined) {
    invalidRow(path);
  }
  current[last] = value;
}

/**
 * Собирает DTO-скаляры из проверяемой строки, различая отсутствие optional и явный null.
 */
export function decodeColumns(
  definitions: readonly ColumnDefinition[],
  row: Readonly<SqlRow>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const definition of definitions) {
    const value =
      definition.storage === "text" ? decodeText(row, definition.column) : row[definition.column];
    if (value === null && definition.optional) {
      continue;
    }
    if (value === null && definition.nullable) {
      assignField(data, definition.field, null);
      continue;
    }
    let decoded: SqlScalar | boolean;
    if (definition.storage === "boolean") {
      if (value !== 0 && value !== 1) {
        invalidRow(definition.column);
      }
      decoded = value === 1;
    } else if (definition.storage === "integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        invalidRow(definition.column);
      }
      decoded = value;
    } else {
      if (typeof value !== "string" || (definition.values && !definition.values.includes(value))) {
        invalidRow(definition.column);
      }
      decoded = value;
      if (definition.storage === "string") {
        identityText(decoded, definition.column);
      }
    }
    assignField(data, definition.field, decoded);
  }
  return data;
}

/**
 * Отвергает неописанные поля вместо тихой потери или универсального JSON fallback.
 */
export function assertKnownFields(
  data: Readonly<Record<string, unknown>>,
  definitions: readonly ColumnDefinition[],
  additional: readonly string[] = [],
): void {
  const allowed = new Set([
    ...definitions.map((field) => field.field.split(".")[0]),
    ...additional,
  ]);
  for (const field of Object.keys(data)) {
    if (!allowed.has(field)) {
      invalidRow(field);
    }
  }
}

/**
 * Возвращает фактические SQL-слоты декларации в постоянном порядке.
 */
export function columnNames(definitions: readonly ColumnDefinition[]): string[] {
  return definitions.flatMap((field) =>
    field.storage === "text" ? [field.column, `${field.column}_json`] : [field.column],
  );
}

/**
 * SQL-выражение JSON-значения одного скаляра без lossy извлечения text carrier.
 */
export function columnJson(definition: ColumnDefinition, alias = "r"): string {
  const value = `${alias}.${definition.column}`;
  if (definition.storage === "text") {
    return `json(coalesce(${value}_json,json_quote(${value})))`;
  }
  if (definition.storage === "boolean") {
    return `json(CASE ${value} WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE 'null' END)`;
  }
  return value;
}

/**
 * Строит закрытую JSON-проекцию плоских полей, сохраняя optional без json_patch потери null.
 */
export function columnsJson(definitions: readonly ColumnDefinition[], alias = "r"): string {
  const required = definitions.filter((field) => !field.optional);
  let expression = `json_object(${required.flatMap((field) => [`'${field.field}'`, columnJson(field, alias)]).join(",")})`;
  for (const field of definitions.filter((entry) => entry.optional)) {
    const present =
      field.storage === "text"
        ? `(${alias}.${field.column} IS NOT NULL OR ${alias}.${field.column}_json IS NOT NULL)`
        : `${alias}.${field.column} IS NOT NULL`;
    expression = `CASE WHEN ${present} THEN json_set(${expression},'$.${field.field}',${columnJson(field, alias)}) ELSE ${expression} END`;
  }
  return expression;
}

/**
 * Выдаёт DDL только для скалярных слотов; предметные FK/CHECK располагаются у таблиц.
 */
export function columnsDdl(definitions: readonly ColumnDefinition[]): string[] {
  return definitions.flatMap((field) => {
    const column = field.column;
    if (field.storage === "text") {
      const limit = field.nullable || field.optional ? "<=1" : "=1";
      return [
        `${column} TEXT`,
        `${column}_json TEXT CHECK(${column}_json IS NULL OR (json_valid(${column}_json) AND json_type(${column}_json)='text')) CHECK(((${column} IS NOT NULL)+(${column}_json IS NOT NULL))${limit})`,
      ];
    }
    const required = field.nullable || field.optional ? "" : " NOT NULL";
    let constraint = "";
    if (field.values) {
      constraint = ` CHECK(${column} IN (${field.values.map((value) => `'${value}'`).join(",")}))`;
    } else if (field.storage === "boolean") {
      constraint = ` CHECK(${column} IN (0,1))`;
    }
    return [`${column} ${field.storage === "string" ? "TEXT" : "INTEGER"}${required}${constraint}`];
  });
}
