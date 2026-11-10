import type { SynchronizationSchedule } from "@relay/storage";

/**
 * Бюджеты ленивого обмена: время проверяется только при обращении, постоянного таймера нет.
 */
export const SYNC_DEBOUNCE = Object.freeze({
  delayMs: 2000,
  maxWaitMs: 10_000,
  pollMs: 5000,
  continuationMs: 500,
  retryLimitMs: 60_000,
});

/**
 * Вычисляет срок по durable отметкам; чтения не продлевают debounce, backoff имеет приоритет.
 */
export function synchronizationDueAt(schedule: SynchronizationSchedule): number {
  if (schedule.mode === "manual") {
    return Number.POSITIVE_INFINITY;
  }
  if (schedule.dirtySince === null || schedule.lastMutationAt === null) {
    return schedule.nextAttemptAt;
  }
  return Math.max(
    schedule.nextAttemptAt,
    Math.min(
      schedule.lastMutationAt + SYNC_DEBOUNCE.delayMs,
      schedule.dirtySince + SYNC_DEBOUNCE.maxWaitMs,
    ),
  );
}

/**
 * Возвращает конечный backoff после отказа; фактический повтор выполнит следующее обращение Relay.
 */
export function synchronizationRetryDelay(failures: number): number {
  return Math.min(SYNC_DEBOUNCE.retryLimitMs, 1000 * 2 ** Math.min(failures + 1, 6));
}
