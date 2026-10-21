/** Правила владения, закрытия и дерева истории работают с уже декодированным снимком. */
import {
  RelayError,
  type HistoryCheckpoint,
  type HistoryRun,
  type HistorySession,
} from "@relay/contracts";
import { invalidHistoryInput } from "./history-input";

export function historyConflict(message: string, details?: Record<string, unknown>): never {
  throw new RelayError("CONFLICT", message, 4, details);
}

export function unfinishedSession(session: HistorySession): boolean {
  return session.data.status !== "completed" && session.data.status !== "cancelled";
}

export function checkHistoryRevision(session: HistorySession, expected: number): void {
  if (session.revision !== expected) {
    throw new RelayError(
      "REVISION_CONFLICT",
      "Ревизия сессии изменилась. Перечитайте её состояние и историю.",
      4,
      {
        sessionId: session.id,
        expectedRevision: expected,
        actualRevision: session.revision,
      },
    );
  }
}

export function checkHistoryOwner(
  session: HistorySession,
  runId: string | null,
  actor: string,
): HistoryRun {
  if (runId === null) invalidHistoryInput("runId: требуется постоянный ID текущего участия.");
  if (session.data.status !== "open" || session.data.currentRunId === null) {
    historyConflict("Владельческая запись требует открытой сессии с текущим участием.");
  }
  if (session.data.currentRunId !== runId) {
    historyConflict("Этот run не владеет сессией. Требуется постоянный ID текущего участия.");
  }
  const run = session.data.runs.find((entry) => entry.id === runId);
  if (!run || run.state !== "active" || run.actor !== actor) {
    historyConflict("Автор записи должен совпадать с агентом текущего активного участия.");
  }
  return run;
}

export function endHistoryRun(
  session: HistorySession,
  state: Exclude<HistoryRun["state"], "active">,
  reason: string,
  now: string,
): void {
  const run = session.data.runs.find((entry) => entry.id === session.data.currentRunId);
  if (!run || run.state !== "active") historyConflict("У сессии отсутствует активное участие.");
  run.state = state;
  run.endedAt = now;
  run.endReason = reason;
  session.data.currentRunId = null;
}

export function checkOpenHistoryIntent(
  intent: HistoryCheckpoint,
  checkpoints: HistoryCheckpoint[],
): void {
  if (intent.data.kind !== "intent")
    invalidHistoryInput("Ссылка должна указывать на исходный intent.");
  const closed = checkpoints.some(
    (entry) =>
      entry.data.intentId === intent.id &&
      (entry.data.kind === "result" || entry.data.kind === "cancel"),
  );
  if (closed)
    historyConflict("Намерение уже закрыто. Создайте новое намерение для дальнейшей работы.");
}

export function checkHistoryAcceptance(
  sessionId: string,
  intentId: string,
  accepted: HistorySession[],
): void {
  for (const child of accepted) {
    if (child.data.parentSessionId !== sessionId || child.data.originCheckpointId !== intentId) {
      historyConflict("Можно принять только прямого ребёнка исходного намерения.");
    }
    if (child.data.status !== "completed") {
      historyConflict("Принимается только результат завершённого, не отменённого ребёнка.");
    }
  }
}

export function checkHistoryChildrenClosure(
  sessionId: string,
  intentId: string | null,
  accepted: string[],
  sessions: HistorySession[],
  checkpoints: HistoryCheckpoint[],
): void {
  const acceptedIds = new Set(accepted);
  for (const entry of checkpoints) {
    if (entry.data.sessionId !== sessionId) continue;
    if (intentId !== null && entry.data.intentId !== intentId) continue;
    for (const id of entry.data.acceptedSessionIds) acceptedIds.add(id);
  }
  for (const child of sessions) {
    if (child.data.parentSessionId !== sessionId) continue;
    if (intentId !== null && child.data.originCheckpointId !== intentId) continue;
    if (unfinishedSession(child))
      historyConflict("Сначала закройте дочернюю работу.", { childSessionId: child.id });
    if (child.data.status === "completed" && !acceptedIds.has(child.id)) {
      historyConflict("Результат дочерней работы ещё не принят родителем.", {
        childSessionId: child.id,
      });
    }
  }
}

export function historySubtree(root: HistorySession, sessions: HistorySession[]): HistorySession[] {
  const children = new Map<string, HistorySession[]>();
  for (const session of sessions) {
    if (session.data.parentSessionId === null) continue;
    const siblings = children.get(session.data.parentSessionId) ?? [];
    siblings.push(session);
    children.set(session.data.parentSessionId, siblings);
  }
  const visited = new Set<string>();
  const queue = [root];
  for (let position = 0; position < queue.length; position += 1) {
    const session = queue[position]!;
    if (visited.has(session.id)) historyConflict("Обнаружен цикл дочерних сессий.");
    visited.add(session.id);
    queue.push(...(children.get(session.id) ?? []));
  }
  return queue;
}
