import { RelayError } from "../errors/relay-error";
import { componentMessages } from "./component.messages";

/**
 * Копирует только конечную JSON-форму без DOM/Bun и без преобразования не-JSON значений в null.
 * undefined, NaN, Infinity, разреженные массивы и объекты классов отклоняются явно.
 */
export function cloneComponentData<T>(value: T): T {
  // Копирование не меняет форму допустимого JSON; неподдерживаемое значение отклоняется.
  return cloneJsonValue(value, new Set()) as T;
}

/**
 * Рекурсивно сохраняет все значения JSON и собственные ключи, включая безопасный __proto__.
 */
function cloneJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "object" && !ancestors.has(value)) {
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return Array.from(value, (item) => cloneJsonValue(item, ancestors));
      }
      if (
        Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null
      ) {
        if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
          throw new RelayError("CORRUPT_DATA", componentMessages.json, 1);
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item, ancestors)]),
        );
      }
    } finally {
      ancestors.delete(value);
    }
  }
  throw new RelayError("CORRUPT_DATA", componentMessages.json, 1);
}
