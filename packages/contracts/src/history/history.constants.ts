/**
 * Состояния рабочей сессии от ожидания исполнителя до закрытия.
 */
export const historySessionStatuses = [
  "pending",
  "open",
  "paused",
  "completed",
  "cancelled",
] as const;

/**
 * Виды неизменяемых материалов истории, связанных с намерением работы.
 */
export const historyCheckpointKinds = ["intent", "progress", "result", "cancel"] as const;

/**
 * Состояния одного участия исполнителя в рабочей сессии.
 */
export const historyRunStates = [
  "active",
  "paused",
  "transferred",
  "completed",
  "cancelled",
] as const;

/**
 * Источники сведений о пользователе, от имени которого действует исполнитель.
 */
export const historyOperatorSources = ["explicit", "environment", "git", "inherited"] as const;
