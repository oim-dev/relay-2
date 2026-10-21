/**
 * Диагностики драйвера SQLite и ограничений схемы; тексты триггеров сохраняют свой формат.
 */
export const sqliteMessages = {
  busy: "База занята другой операцией записи.",
  integrityConflict: "Нарушено ограничение целостности базы данных.",
  databaseError: "Ошибка локальной базы данных.",
  commentTargetConstraint: "comment target must be a task",
  appendOnlyConstraint: "task comments are append-only",
  immutableEntityConstraint: "immutable entity fields or invalid revision",
} as const;
