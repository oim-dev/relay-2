/**
 * Принадлежащий supervisor долгоживущий guardian; lifetime не связан с request-component.
 */
export interface OwnedWorker {
  /* Отмена только этого worker/job. */
  readonly cancellation: AbortController;
  /* Завершение включает cleanup всех его потомков. */
  completion: Promise<void>;
  /* Ранний отказ сохраняется для readiness диагностики. */
  failure: unknown;
  /* True только после завершения guardian и закрытия потоков. */
  done: boolean;
}
