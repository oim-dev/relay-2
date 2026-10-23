/**
 * Границы переносимого формата пакета v1, общие для Core и интерфейсов ввода.
 */
export const BATCH_LIMITS = {
  /* Максимальный размер UTF-8 JSON в байтах: 8 MiB. */
  inputBytes: 8 * 1024 * 1024,
  /* Максимальное число последовательных предметных действий; минимум — одно. */
  operations: 200,
} as const;

/**
 * Виды вложенных результатов пакета, не имеющих самостоятельной карточки сущности.
 * Общий перечень используется переносимым типом и декодированием исторической квитанции.
 */
export const BATCH_NESTED_RESULT_KINDS = [
  "plan-stage",
  "task-criterion",
  "task-comment",
  "document-section",
  "session-run",
] as const;
