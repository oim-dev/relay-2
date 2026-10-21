/**
 * Виды локальных записей; SQL-схема отдельно фиксирует значения своей версии.
 */
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

/**
 * Границы длины идентичности автора в кодовых единицах UTF-16 (String.length).
 */
export const ACTOR_LENGTH = { min: 1, max: 256 } as const;

/**
 * Границы длины канонического имени проекта в кодовых единицах UTF-16 (String.length).
 */
export const PROJECT_NAME_LENGTH = { min: 1, max: 120 } as const;

/**
 * Границы длины slug проекта, приложения и доски; допустимы только ASCII-символы.
 */
export const ENTITY_SLUG_LENGTH = { min: 2, max: 64 } as const;
