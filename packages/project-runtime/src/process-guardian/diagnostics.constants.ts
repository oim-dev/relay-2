/**
 * Закрытый набор этапов запуска для безопасной межпроцессной диагностики.
 */
export const guardianFailureStages = [
  "guardian-spawn",
  "anchor-spawn",
  "container-setup",
  "command-spawn",
] as const;

/* Символический код ОС ограничен независимо от бюджета stdout/stderr. */
export const maxSystemCodeLength = 64;
