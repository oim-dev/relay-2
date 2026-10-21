/**
 * Состояния рабочего плана; допустимые переходы проверяет Core.
 */
export const PLAN_STATUSES = ["draft", "active", "completed", "cancelled"] as const;

/**
 * Состояния релиза, независимо от текущей готовности включённых планов.
 */
export const RELEASE_STATUSES = ["planned", "released", "cancelled"] as const;

/**
 * Виды предметных целей, обозначающих область рабочего плана.
 */
export const PLAN_SCOPE_KINDS = [
  "project",
  "product",
  "application",
  "feature",
  "scenario",
  "implementation",
] as const;
