import { booleanQuery, filters, integerQuery } from "../../http/query";

/**
 * Декодирует только wire-типы новой проекции. Значения и сочетания проверяет Core.
 * Неизвестные поля сохраняются до предметной проверки, а не игнорируются транспортом.
 */
export function taskViewQuery(query: URLSearchParams): Readonly<Record<string, unknown>> {
  const result = filters(query, ["offset", "limit", "generation", "availableOnly", "refs"]);
  if (query.has("refs")) {
    result.refs = query.getAll("refs");
  }
  for (const key of ["offset", "limit", "generation"] as const) {
    const value = integerQuery(query, key);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  const availableOnly = booleanQuery(query, "availableOnly");
  if (availableOnly !== undefined) {
    result.availableOnly = availableOnly;
  }
  return result;
}
