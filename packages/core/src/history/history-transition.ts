import { isDeepStrictEqual } from "node:util";
import type { HistoryCheckpoint, HistorySession } from "@relay/contracts";
import { decodeHistoryCheckpoint, decodeHistorySession } from "./history-data";
import { historyStateMessages } from "./history-messages";
import { assertHistoryContinuity } from "./history-run-transition";
import {
  checkHistoryAcceptance,
  checkHistoryChildrenClosure,
  checkHistoryConnectionState,
  checkHistoryOwner,
  checkOpenHistoryIntent,
  historyConflict,
  openHistoryIntents,
  unfinishedSession,
} from "./history-rules";
import type { HistoryTransitionContext } from "./history-transition.types";
import { inferHistoryOperation } from "./history-transition-inference";

/**
 * Требует доказанное соответствие эффекта выбранному действию.
 */
function requireTransition(condition: boolean): void {
  if (!condition) {
    historyConflict(historyStateMessages.invalidTransition);
  }
}

/**
 * Находит обязательного владельца в переданных значениях; ничего не догружает.
 */
function sessionFrom(sessions: readonly HistorySession[], id: string | null): HistorySession {
  const session = sessions.find((entry) => entry.id === id);
  if (session === undefined) {
    historyConflict(historyStateMessages.invalidTransition);
  }
  return session;
}

/**
 * Находит исходный intent, сохраняя проверку вида в общем предметном правиле.
 */
function intentFrom(
  checkpoints: readonly HistoryCheckpoint[],
  id: string | null,
): HistoryCheckpoint {
  const intent = checkpoints.find((entry) => entry.id === id);
  if (intent === undefined) {
    historyConflict(historyStateMessages.invalidTransition);
  }
  return intent;
}

/**
 * Связывает новое участие с выделенной ролью результата, а не с любым существующим run владельца.
 * Неизменность прежней цепочки отдельно проверяет continuity; роль обязательна и при пустом эффекте.
 */
function assertNewRunTarget(next: HistorySession, context: HistoryTransitionContext): void {
  requireTransition(
    context.newRunId !== undefined &&
      next.data.currentRunId === context.newRunId &&
      next.data.runs.at(-1)?.id === context.newRunId,
  );
}

/**
 * Проверяет обе стороны происхождения ребёнка и участие создателя, даже после takeover родителя.
 */
export function assertHistoryChildOrigin(
  child: HistorySession,
  parent: HistorySession,
  intent: HistoryCheckpoint,
): void {
  requireTransition(
    child.id !== parent.id &&
      intent.data.kind === "intent" &&
      intent.data.sessionId === parent.id &&
      child.data.parentSessionId === parent.id &&
      child.data.originCheckpointId === intent.id &&
      parent.data.runs.some((run) => run.id === child.data.createdByRunId),
  );
}

/**
 * Проверяет относящихся к сессии детей, включая повреждённую неполную обратную связь.
 */
function checkChildren(session: HistorySession, context: HistoryTransitionContext): void {
  const ownIntents = context.beforeCheckpoints.filter(
    (entry) => entry.data.sessionId === session.id && entry.data.kind === "intent",
  );
  const intentIds = new Set(ownIntents.map((entry) => entry.id));
  for (const child of context.beforeSessions) {
    if (
      child.data.parentSessionId === session.id ||
      (child.data.originCheckpointId !== null && intentIds.has(child.data.originCheckpointId))
    ) {
      assertHistoryChildOrigin(
        child,
        session,
        intentFrom(context.beforeCheckpoints, child.data.originCheckpointId),
      );
    }
  }
}

/**
 * Проверяет первичное создание корня либо pending-ребёнка с активным создателем.
 */
function assertSessionCreation(next: HistorySession, context: HistoryTransitionContext): void {
  requireTransition(next.createdBy === context.actor && next.updatedBy === context.actor);
  requireTransition(!context.beforeSessions.some((entry) => entry.id === next.id));
  if (context.operation === "session.start") {
    assertNewRunTarget(next, context);
    requireTransition(
      next.data.status === "open" &&
        next.data.parentSessionId === null &&
        next.data.runs.length === 1,
    );
    checkHistoryOwner(next, next.data.currentRunId, context.actor);
    requireTransition(next.data.currentRunId !== next.id);
    return;
  }
  requireTransition(context.operation === "session.fork" && next.data.status === "pending");
  const parent = sessionFrom(context.beforeSessions, next.data.parentSessionId);
  const intent = intentFrom(context.beforeCheckpoints, next.data.originCheckpointId);
  assertHistoryChildOrigin(next, parent, intent);
  checkHistoryOwner(parent, next.data.createdByRunId, context.actor);
  checkOpenHistoryIntent(intent, context.beforeCheckpoints);
  const updated = sessionFrom(context.afterSessions, parent.id);
  requireTransition(
    isDeepStrictEqual(updated.data, parent.data) && updated.updatedBy === context.actor,
  );
}

/**
 * Проверяет добавление ровно одного run и единственный допустимый переход прежнего участия.
 */
function assertConnection(
  previous: HistorySession,
  next: HistorySession,
  context: HistoryTransitionContext,
): void {
  const action = context.operation.slice("session.".length);
  if (action !== "attach" && action !== "resume" && action !== "takeover") {
    historyConflict(historyStateMessages.invalidTransition);
  }
  const run = next.data.runs.at(-1);
  assertNewRunTarget(next, context);
  requireTransition(run !== undefined && next.data.runs.length === previous.data.runs.length + 1);
  if (run === undefined) {
    return;
  }
  checkHistoryConnectionState(previous, {
    action,
    client: run.client,
    sourceSessionId: run.sourceSessionId,
    reason: run.reason ?? "",
    operator: run.operator,
  });
  checkHistoryOwner(next, run.id, context.actor);
  requireTransition(run.predecessorRunId === (previous.data.runs.at(-1)?.id ?? null));
  if (action === "takeover") {
    const ended = next.data.runs[previous.data.runs.length - 1];
    requireTransition(
      run.reason !== null &&
        run.reason.trim().length > 0 &&
        ended?.state === "transferred" &&
        ended.endReason === run.reason,
    );
  } else {
    requireTransition(isDeepStrictEqual(next.data.runs.slice(0, -1), previous.data.runs));
  }
  if (action === "attach") {
    const parent = sessionFrom(context.beforeSessions, previous.data.parentSessionId);
    assertHistoryChildOrigin(
      previous,
      parent,
      intentFrom(context.beforeCheckpoints, previous.data.originCheckpointId),
    );
  }
}

/**
 * Проверяет паузу либо окончательное закрытие без открытия нового участия.
 */
function assertSessionClosure(
  previous: HistorySession,
  next: HistorySession,
  context: HistoryTransitionContext,
): void {
  const paused = context.operation === "session.pause";
  let status: "paused" | "completed" | "cancelled" = "cancelled";
  if (paused) {
    status = "paused";
  } else if (context.operation === "session.complete") {
    status = "completed";
  }
  requireTransition(
    next.data.status === status && next.data.runs.length === previous.data.runs.length,
  );
  if (paused || status === "completed" || previous.data.status === "open") {
    checkHistoryOwner(previous, previous.data.currentRunId, context.actor);
    const last = next.data.runs.at(-1);
    requireTransition(
      last?.state === status &&
        last.endReason !== null &&
        (paused || last.endReason === next.data.result),
    );
  } else {
    requireTransition(isDeepStrictEqual(previous.data.runs, next.data.runs));
  }
  if (!paused) {
    const materials = context.beforeCheckpoints.filter(
      (entry) => entry.data.sessionId === previous.id,
    );
    const intentIds = new Set(
      materials.filter((entry) => entry.data.kind === "intent").map((entry) => entry.id),
    );
    for (const entry of context.beforeCheckpoints) {
      if (entry.data.intentId !== null && intentIds.has(entry.data.intentId)) {
        requireTransition(entry.data.sessionId === previous.id);
      }
    }
    if (
      openHistoryIntents(context.beforeCheckpoints).some(
        (entry) => entry.data.sessionId === previous.id,
      )
    ) {
      historyConflict(historyStateMessages.openIntents);
    }
    checkChildren(previous, context);
    checkHistoryChildrenClosure(previous.id, null, [], context.beforeSessions, materials);
  }
}

/**
 * Проверяет повышение владельца checkpoint/fork без изменения его содержания.
 */
function assertOwnerTouch(
  previous: HistorySession,
  next: HistorySession,
  context: HistoryTransitionContext,
): void {
  checkHistoryOwner(previous, previous.data.currentRunId, context.actor);
  requireTransition(isDeepStrictEqual(previous.data, next.data));
  if (context.operation === "session.fork") {
    const existing = new Set(context.beforeSessions.map((entry) => entry.id));
    const children = context.afterSessions.filter(
      (entry) => !existing.has(entry.id) && entry.data.parentSessionId === previous.id,
    );
    requireTransition(children.length === 1);
    for (const child of children) {
      assertSessionCreation(child, context);
    }
  } else {
    const existing = new Set(context.beforeCheckpoints.map((entry) => entry.id));
    const added = context.afterCheckpoints.filter(
      (entry) => !existing.has(entry.id) && entry.data.sessionId === previous.id,
    );
    requireTransition(added.length === 1);
    for (const checkpoint of added) {
      assertCheckpointCreation(checkpoint, context);
    }
  }
}

/**
 * Проверяет материал относительно владельца и исходной истории шага, не final-state пакета.
 * sessionRevision — историческое поле источника; оно не сравнивается с локальной CAS-ревизией.
 */
function assertCheckpointCreation(
  next: HistoryCheckpoint,
  context: HistoryTransitionContext,
): void {
  const operations = {
    intent: "checkpoint.open",
    progress: "checkpoint.save",
    result: "checkpoint.complete",
    cancel: "checkpoint.cancel",
  } as const;
  requireTransition(
    context.operation === operations[next.data.kind] && next.data.actor === context.actor,
  );
  const session = sessionFrom(context.beforeSessions, next.data.sessionId);
  checkHistoryOwner(session, next.data.runId, context.actor);
  const updated = sessionFrom(context.afterSessions, session.id);
  requireTransition(
    isDeepStrictEqual(updated.data, session.data) && updated.updatedBy === context.actor,
  );
  const materials = context.beforeCheckpoints.filter(
    (entry) => entry.data.sessionId === session.id,
  );
  requireTransition(
    next.data.sequence ===
      materials.reduce((max, entry) => Math.max(max, entry.data.sequence), 0) + 1,
  );
  if (next.data.intentId !== null) {
    const intent = intentFrom(context.beforeCheckpoints, next.data.intentId);
    requireTransition(intent.data.sessionId === session.id);
    checkOpenHistoryIntent(intent, context.beforeCheckpoints);
    const accepted = next.data.acceptedSessionIds.map((id) =>
      sessionFrom(context.beforeSessions, id),
    );
    checkHistoryAcceptance(session.id, intent.id, accepted);
    if (next.data.kind === "result" || next.data.kind === "cancel") {
      checkChildren(session, context);
      checkHistoryChildrenClosure(
        session.id,
        intent.id,
        next.data.acceptedSessionIds,
        context.beforeSessions,
        materials,
      );
    }
  }
}

/**
 * Единый чистый валидатор ordered-перехода для локальных commands и переносимой публикации.
 * Проверяет status edges, владение, append-only цепочку, происхождение и закрытие.
 * Вход не меняется; ID, часы и I/O отсутствуют, локальные revision не сравниваются.
 */
export function assertHistoryTransition(
  previous: HistorySession | HistoryCheckpoint | null,
  next: HistorySession | HistoryCheckpoint,
  context: HistoryTransitionContext,
): void {
  if (context.operation === "replication") {
    assertHistoryTransition(previous, next, {
      ...context,
      operation: inferHistoryOperation(previous, next, context),
      ...(next.kind === "work-session" && next.data.currentRunId !== null
        ? { newRunId: next.data.currentRunId }
        : {}),
    });
    return;
  }
  if (next.kind === "work-checkpoint") {
    decodeHistoryCheckpoint(next);
    if (previous !== null) {
      const { revision: _beforeRevision, ...before } = previous;
      const { revision: _afterRevision, ...after } = next;
      if (!isDeepStrictEqual(before, after)) {
        historyConflict(historyStateMessages.immutableHistory);
      }
      return;
    }
    assertCheckpointCreation(next, context);
    return;
  }
  decodeHistorySession(next);
  if (previous === null) {
    assertSessionCreation(next, context);
    return;
  }
  if (previous.kind !== "work-session") {
    historyConflict(historyStateMessages.immutableHistory);
  }
  assertHistoryContinuity(previous, next);
  if (!unfinishedSession(previous)) {
    const { revision: _beforeRevision, ...before } = previous;
    const { revision: _afterRevision, ...after } = next;
    requireTransition(isDeepStrictEqual(before, after));
    return;
  }
  requireTransition(next.updatedBy === context.actor);
  switch (context.operation) {
    case "session.attach":
    case "session.resume":
    case "session.takeover":
      assertConnection(previous, next, context);
      return;
    case "session.pause":
    case "session.complete":
    case "session.cancel":
      assertSessionClosure(previous, next, context);
      return;
    case "session.fork":
    case "checkpoint.open":
    case "checkpoint.save":
    case "checkpoint.complete":
    case "checkpoint.cancel":
      assertOwnerTouch(previous, next, context);
      return;
    default:
      historyConflict(historyStateMessages.invalidTransition);
  }
}
