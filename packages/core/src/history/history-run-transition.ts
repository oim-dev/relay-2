import { isDeepStrictEqual } from "node:util";
import type { HistorySession } from "@relay/contracts";
import { historyStateMessages } from "./history-messages";
import { historyConflict } from "./history-rules";

/**
 * Сохраняет происхождение и префикс участий; завершённый run неизменяем.
 * Активному run разрешено изменить только поля завершения, без смены автора/идентичности.
 * Локальная ревизия не участвует в переносимом правиле.
 */
export function assertHistoryContinuity(previous: HistorySession, next: HistorySession): void {
  for (const field of ["id", "kind", "key", "createdAt", "createdBy"] as const) {
    if (previous[field] !== next[field]) {
      historyConflict(historyStateMessages.immutableHistory);
    }
  }
  for (const field of [
    "parentSessionId",
    "originCheckpointId",
    "createdByRunId",
    "title",
    "description",
  ] as const) {
    if (previous.data[field] !== next.data[field]) {
      historyConflict(historyStateMessages.immutableHistory);
    }
  }
  for (const [index, run] of previous.data.runs.entries()) {
    const updated = next.data.runs[index];
    if (
      updated === undefined ||
      updated.id !== run.id ||
      (run.state !== "active" && !isDeepStrictEqual(run, updated))
    ) {
      historyConflict(historyStateMessages.immutableHistory);
    }
    const { state: _state, endedAt: _endedAt, endReason: _endReason, ...identity } = run;
    const {
      state: _nextState,
      endedAt: _nextEndedAt,
      endReason: _nextEndReason,
      ...nextIdentity
    } = updated;
    if (!isDeepStrictEqual(identity, nextIdentity)) {
      historyConflict(historyStateMessages.immutableHistory);
    }
  }
}
