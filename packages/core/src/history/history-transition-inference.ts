import type { HistoryCheckpoint, HistorySession } from "@relay/contracts";
import { historyStateMessages } from "./history-messages";
import { historyConflict } from "./history-rules";
import type { HistoryTransitionContext } from "./history-transition.types";

/**
 * Восстанавливает только однозначный одиночный переход legacy-истории из before/after.
 * Не воспроизводит команду, не назначает ID/время; недоказуемая составная эволюция отклоняется.
 */
export function inferHistoryOperation(
  previous: HistorySession | HistoryCheckpoint | null,
  next: HistorySession | HistoryCheckpoint,
  context: HistoryTransitionContext,
): string {
  if (next.kind === "work-checkpoint") {
    switch (next.data.kind) {
      case "intent":
        return "checkpoint.open";
      case "progress":
        return "checkpoint.save";
      case "result":
        return "checkpoint.complete";
      case "cancel":
        return "checkpoint.cancel";
    }
  }
  if (previous === null) {
    return next.data.parentSessionId === null ? "session.start" : "session.fork";
  }
  if (previous.kind !== "work-session") {
    historyConflict(historyStateMessages.invalidTransition);
  }
  if (next.data.runs.length > previous.data.runs.length) {
    if (next.data.runs.length !== previous.data.runs.length + 1 || next.data.status !== "open") {
      historyConflict(historyStateMessages.invalidTransition);
    }
    switch (previous.data.status) {
      case "pending":
        return "session.attach";
      case "paused":
        return "session.resume";
      case "open":
        return "session.takeover";
      default:
        return historyConflict(historyStateMessages.closedSession);
    }
  }
  if (next.data.status !== previous.data.status) {
    switch (next.data.status) {
      case "paused":
        return "session.pause";
      case "completed":
        return "session.complete";
      case "cancelled":
        return "session.cancel";
      default:
        return historyConflict(historyStateMessages.invalidTransition);
    }
  }
  const oldSessions = new Set(context.beforeSessions.map((entry) => entry.id));
  const children = context.afterSessions.filter(
    (entry) => entry.data.parentSessionId === next.id && !oldSessions.has(entry.id),
  );
  const oldMaterials = new Set(context.beforeCheckpoints.map((entry) => entry.id));
  const materials = context.afterCheckpoints.filter(
    (entry) => entry.data.sessionId === next.id && !oldMaterials.has(entry.id),
  );
  if (children.length === 1 && materials.length === 0) {
    return "session.fork";
  }
  if (children.length === 0 && materials.length === 1) {
    const checkpoint = materials[0];
    if (checkpoint !== undefined) {
      return inferHistoryOperation(null, checkpoint, context);
    }
  }
  return historyConflict(historyStateMessages.invalidTransition);
}
