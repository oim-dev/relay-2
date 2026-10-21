import type { HistoryCheckpoint, HistorySession } from "@relay/contracts";

/**
 * Подготовленная сессия с текущим участием и единственным открытым намерением.
 */
export interface OpenIntentFixture {
  /* Сессия после открытия намерения; её ревизия используется следующей записью истории. */
  readonly session: HistorySession;

  /* Постоянный ID текущего участия, которым владеет подготовленный исполнитель. */
  readonly runId: string;

  /* Сохранённый материал открытого намерения. */
  readonly intent: HistoryCheckpoint;
}
