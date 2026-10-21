/**
 * Диагностики проверки курсора и согласованности страниц CLI.
 */
export const paginationMessages = {
  invalidCursor: "Повреждённый курсор страницы",
  mismatchedCursor: "Курсор относится к другому проекту или запросу",
  changedSnapshot: "Данные изменились. Начните список заново без --cursor",
} as const;
