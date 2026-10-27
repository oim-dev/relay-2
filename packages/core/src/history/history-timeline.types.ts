import type {
  HistoryTimelinePoint,
  HistoryTimelineRun,
  HistoryTimelineSession,
} from "@relay/contracts";

/**
 * Проверенный metadata-граф одного снимка, без полных материалов.
 */
export interface TimelineIndex {
  /* Сессии по постоянным ID. */
  readonly sessions: Map<string, HistoryTimelineSession>;
  /* Все авторские участия по scoped ключу [sessionId, runId]. */
  readonly runs: Map<string, HistoryTimelineRun>;
  /* Точки каждой линии в прямом порядке. */
  readonly lines: Map<string, HistoryTimelinePoint[]>;
}
