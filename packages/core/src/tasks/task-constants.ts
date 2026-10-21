/**
 * Ограничения задач; длины строк измеряются в кодовых единицах UTF-16.
 * Лимиты текстов критериев применяются и к внешнему вводу, и к сохранённому содержанию.
 */
export const TASK_LIMITS = {
  reference: 256,
  title: 1024,
  description: 256 * 1024,
  search: 1024,
  criterionTitle: 1024,
  criterionSummary: 4096,
  criterionDescription: 256 * 1024,
  criteria: 100,
  links: 200,
  targets: 100,
  commentTitle: 1024,
  commentBody: 256 * 1024,
} as const;

/**
 * Единые правила текстов критерия для внешнего ввода и декодирования хранения.
 * Заголовок обязателен и однострочен; пояснения допускают пустоту и переносы строк.
 */
export const TASK_CRITERION_TEXT_RULES = {
  title: { maximum: TASK_LIMITS.criterionTitle, singleLine: true, required: true },
  summary: { maximum: TASK_LIMITS.criterionSummary, singleLine: false, required: false },
  description: { maximum: TASK_LIMITS.criterionDescription, singleLine: false, required: false },
} as const;

/**
 * Поддерживаемые операции с критериями приёмки.
 */
export const TASK_CRITERION_ACTIONS = ["add", "update", "complete", "reopen", "remove"] as const;

/**
 * Поля содержания критерия, изменение которых снимает отметку выполнения.
 */
export const TASK_CRITERION_FIELDS = ["title", "summary", "description"] as const;

/**
 * Значения вычисляемых фильтров задач.
 */
export const TASK_FILTER_VALUES = {
  completion: ["finished", "unfinished"],
  searchIn: ["title", "all"],
  readiness: ["ready", "blocked"],
} as const;
