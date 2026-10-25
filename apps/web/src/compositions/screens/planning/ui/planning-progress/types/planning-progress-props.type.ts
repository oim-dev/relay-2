import type { PlanProgress, ReleaseProgress } from "@relay/contracts";
/**
 * Серверный результат готовности с независимой диагностикой чтения.
 */
export interface PlanningProgressProps {
  /* Актуальный предметный расчёт; отсутствие не означает нулевую готовность. */
  readonly progress: PlanProgress | ReleaseProgress | undefined;
  /* Ошибка запроса; undefined при отсутствии ошибки. */
  readonly error: unknown;
  /* Явное повторение чтения, не предметной команды. */
  readonly onRefresh: () => void;
}
