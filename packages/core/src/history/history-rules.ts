/**
 * Правила владения, закрытия и дерева истории работают с уже декодированным снимком без БД.
 */
import {
  RelayError,
  type HistoryCheckpoint,
  type HistoryRun,
  type HistorySession,
} from "@relay/contracts";
import { invalidHistoryInput } from "./history-input";
import type { HistoryConnectTransition } from "./history-input.types";
import { historyInputMessages, historyStateMessages } from "./history-messages";

const connectionStatuses = {
  attach: "pending",
  resume: "paused",
  takeover: "open",
} as const;

/**
 * Отклоняет конфликт предметного состояния, сохраняя структурированные сведения об участниках.
 */
export function historyConflict(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new RelayError("CONFLICT", message, 4, details);
}

/**
 * Считает pending, open и paused незавершённой работой, которую ещё можно продолжить или отменить.
 */
export function unfinishedSession(session: Readonly<HistorySession>): boolean {
  return session.data.status !== "completed" && session.data.status !== "cancelled";
}

/**
 * Проверяет CAS владельца изменения до проверки состояния, включая повторный запрос перехода.
 */
export function checkHistoryRevision(session: Readonly<HistorySession>, expected: number): void {
  if (session.revision !== expected) {
    throw new RelayError("REVISION_CONFLICT", historyStateMessages.revisionConflict, 4, {
      sessionId: session.id,
      expectedRevision: expected,
      actualRevision: session.revision,
    });
  }
}

/**
 * Возвращает активное участие только при совпадении постоянного ID и автора записи.
 * Отсутствующий runId — INVALID_INPUT; чужой run, автор или статус — CONFLICT.
 */
export function checkHistoryOwner(
  session: Readonly<HistorySession>,
  runId: string | null,
  actor: string,
): HistoryRun {
  if (runId === null) {
    invalidHistoryInput(historyInputMessages.runRequired);
  }
  if (session.data.status !== "open" || session.data.currentRunId === null) {
    historyConflict(historyStateMessages.openSessionRequired);
  }
  if (session.data.currentRunId !== runId) {
    historyConflict(historyStateMessages.currentRunRequired);
  }
  const run = session.data.runs.find((entry) => entry.id === runId);
  if (!run || run.state !== "active" || run.actor !== actor) {
    historyConflict(historyStateMessages.runActorRequired);
  }
  return run;
}

/**
 * Проверяет исходный статус для создания нового участия до изменения существующего run.
 */
export function checkHistoryConnectionState(
  session: Readonly<HistorySession>,
  input: HistoryConnectTransition,
): void {
  const expected = connectionStatuses[input.action];
  if (session.data.status !== expected) {
    historyConflict(historyStateMessages.connectionStateRequired(input.action, expected));
  }
}

/**
 * Завершает текущий run в переданном объекте и снимает его владение сессией.
 * Вызывающий сценарий проверяет полномочия и сохраняет изменение в общей транзакции.
 */
export function endHistoryRun(
  session: HistorySession,
  state: Exclude<HistoryRun["state"], "active">,
  reason: string,
  now: string,
): void {
  const run = session.data.runs.find((entry) => entry.id === session.data.currentRunId);
  if (!run || run.state !== "active") {
    historyConflict(historyStateMessages.activeRunMissing);
  }
  run.state = state;
  run.endedAt = now;
  run.endReason = reason;
  session.data.currentRunId = null;
}

/**
 * Проверяет, что исходный материал — intent без результата или отмены в том же снимке.
 */
export function checkOpenHistoryIntent(
  intent: Readonly<HistoryCheckpoint>,
  checkpoints: readonly HistoryCheckpoint[],
): void {
  if (intent.data.kind !== "intent") {
    invalidHistoryInput(historyInputMessages.intentRequired);
  }
  const closed = checkpoints.some(
    (entry) => entry.data.intentId === intent.id && historyIntentOutcome(entry.data.kind) !== null,
  );
  if (closed) {
    historyConflict(historyStateMessages.closedIntent);
  }
}

/**
 * Разрешает принимать только завершённые прямые дочерние поручения исходного намерения.
 */
export function checkHistoryAcceptance(
  sessionId: string,
  intentId: string,
  accepted: readonly HistorySession[],
): void {
  for (const child of accepted) {
    if (child.data.parentSessionId !== sessionId || child.data.originCheckpointId !== intentId) {
      historyConflict(historyStateMessages.directChildRequired);
    }
    if (child.data.status !== "completed") {
      historyConflict(historyStateMessages.completedChildRequired);
    }
  }
}

/**
 * Запрещает закрытие при незавершённых детях или непринятых завершённых результатах.
 * intentId=null проверяет всех прямых детей сессии; иначе только детей этого намерения.
 * Учитывает принятие из предыдущих материалов и текущего ввода, не изменяя снимок.
 */
export function checkHistoryChildrenClosure(
  sessionId: string,
  intentId: string | null,
  accepted: readonly string[],
  sessions: readonly HistorySession[],
  checkpoints: readonly HistoryCheckpoint[],
): void {
  const acceptedIds = new Set(accepted);
  for (const entry of checkpoints) {
    if (entry.data.sessionId !== sessionId) {
      continue;
    }
    if (intentId !== null && entry.data.intentId !== intentId) {
      continue;
    }
    for (const id of entry.data.acceptedSessionIds) {
      acceptedIds.add(id);
    }
  }
  for (const child of sessions) {
    if (child.data.parentSessionId !== sessionId) {
      continue;
    }
    if (intentId !== null && child.data.originCheckpointId !== intentId) {
      continue;
    }
    if (unfinishedSession(child)) {
      historyConflict(historyStateMessages.unfinishedChild, { childSessionId: child.id });
    }
    if (child.data.status === "completed" && !acceptedIds.has(child.id)) {
      historyConflict(historyStateMessages.unacceptedChild, {
        childSessionId: child.id,
      });
    }
  }
}

/**
 * Возвращает корень и потомков в ширину, сохраняя порядок соседей из снимка.
 * Один индекс строится для всего обхода; повторный узел означает цикл и даёт CONFLICT.
 */
export function historySubtree(
  root: Readonly<HistorySession>,
  sessions: readonly HistorySession[],
): HistorySession[] {
  const children = new Map<string, HistorySession[]>();
  for (const session of sessions) {
    if (session.data.parentSessionId === null) {
      continue;
    }
    const siblings = children.get(session.data.parentSessionId) ?? [];
    siblings.push(session);
    children.set(session.data.parentSessionId, siblings);
  }
  const visited = new Set<string>();
  const queue = [root];
  // Итератор массива посещает добавленных потомков, сохраняя обход в ширину без рекурсии.
  for (const session of queue) {
    if (visited.has(session.id)) {
      historyConflict(historyStateMessages.sessionCycle);
    }
    visited.add(session.id);
    queue.push(...(children.get(session.id) ?? []));
  }
  return queue;
}

/**
 * Выбирает незакрытые intent из материалов одной области, сохраняя исходный порядок.
 */
export function openHistoryIntents(checkpoints: readonly HistoryCheckpoint[]): HistoryCheckpoint[] {
  const closed = new Set(
    checkpoints
      .filter((entry) => historyIntentOutcome(entry.data.kind) !== null)
      .map((entry) => entry.data.intentId),
  );
  return checkpoints.filter((entry) => entry.data.kind === "intent" && !closed.has(entry.id));
}

/**
 * Единственная семантика закрывающего материала для проверок и read-проекций истории.
 */
export function historyIntentOutcome(
  kind: HistoryCheckpoint["data"]["kind"],
): "completed" | "cancelled" | null {
  if (kind === "result") {
    return "completed";
  }
  if (kind === "cancel") {
    return "cancelled";
  }
  return null;
}
