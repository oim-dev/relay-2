import { RelayError } from "./index";

/** Виды локальных записей; SQL-схема отдельно фиксирует допустимые значения своей версии. */
export const ENTITY_KINDS = [
  "project",
  "product",
  "feature",
  "scenario",
  "application",
  "implementation",
  "board",
  "task",
  "document",
  "work-plan",
  "release",
  "work-session",
  "work-checkpoint",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === "string" && (ENTITY_KINDS as readonly string[]).includes(value);
}

/** Идентичность автора сохраняется дословно: исправление пробелов изменило бы владельца участия. */
export function validateActor(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\p{Cc}\u2028\u2029]/u.test(value)
  ) {
    throw new RelayError(
      "INVALID_ARGUMENT",
      "Автор: 1–256 символов без краевых пробелов, управляющих символов и разделителей строк.",
      2,
      { field: "actor" },
    );
  }
  return value;
}
