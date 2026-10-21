import type { ReleaseRecord, WorkPlanRecord } from "@relay/contracts";

/**
 * Запланированный релиз из двух завершённых планов с независимыми готовыми задачами.
 */
export interface CompletedPlanRelease {
  /* Первый завершённый план с двумя задачами. */
  readonly first: WorkPlanRecord;
  /* Второй завершённый план с одной задачей. */
  readonly second: WorkPlanRecord;
  /* Релиз с обоими планами в указанном порядке, ещё не опубликованный. */
  readonly release: ReleaseRecord;
}
