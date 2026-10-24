import type {
  HistoryCheckpoint,
  HistoryCheckpointAction,
  HistorySession,
  WriteOptions,
} from "@relay/contracts";
import { entityCommandEffect } from "../commands/command-entity";
import { decodeHistorySession } from "./history-data";
import type {
  HistoryCheckpointValues,
  HistoryStartValues,
  HistoryTransition,
} from "./history-input.types";
import type {
  HistoryAllocation,
  HistoryCommandDelta,
  HistoryCommandState,
} from "./history-command.types";
import { invalidHistoryInput } from "./history-input";
import { historyInputMessages, historyStateMessages } from "./history-messages";
import { HistoryRecordFactory } from "./history-records";
import {
  checkHistoryConnectionState,
  checkHistoryOwner,
  checkHistoryRevision,
  checkOpenHistoryIntent,
  endHistoryRun,
  historyConflict,
  unfinishedSession,
} from "./history-rules";
import { assertHistoryChildOrigin, assertHistoryTransition } from "./history-transition";
import type { HistoryTransitionContext } from "./history-transition.types";
import { snapshotHistoryReferences } from "./history-references";

/**
 * Требует выделенный до calculator постоянный ID; повторного выделения здесь нет.
 */
function allocatedId(allocation: HistoryAllocation): string {
  if (allocation.id === null) {
    historyConflict(historyStateMessages.allocationExhausted);
  }
  return allocation.id;
}

/**
 * Создаёт независимый следующий снимок владельца: checkpoint/fork меняют ревизию даже без data-delta.
 */
function nextSession(session: HistorySession, allocation: HistoryAllocation): HistorySession {
  const next = decodeHistorySession(session);
  next.revision++;
  next.updatedAt = allocation.now;
  next.updatedBy = allocation.actor;
  return next;
}

/**
 * Собирает before/after именно этого шага из явно загруженного предметного среза.
 * newRunId передаётся из allocation только для нового участия; null у остальных команд.
 */
function transitionContext(
  state: HistoryCommandState,
  owner: HistorySession,
  result: HistorySession | HistoryCheckpoint,
  operation: string,
  actor: string,
  newRunId: string | null = null,
): HistoryTransitionContext {
  const sessions = new Map(state.sessions.map((entry) => [entry.id, entry]));
  sessions.set(owner.id, owner);
  if (result.kind === "work-session") {
    sessions.set(result.id, result);
  }
  return {
    actor,
    operation,
    ...(newRunId === null ? {} : { newRunId }),
    beforeSessions: state.sessions,
    afterSessions: [...sessions.values()],
    beforeCheckpoints: state.checkpoints,
    afterCheckpoints:
      result.kind === "work-checkpoint" ? [...state.checkpoints, result] : state.checkpoints,
  };
}

/**
 * Рассчитывает корневую сессию и первое участие из заранее свободных ID, без I/O.
 */
export function calculateHistoryStart(
  input: HistoryStartValues,
  allocation: HistoryAllocation,
  runId: string,
): HistoryCommandDelta<HistorySession> {
  const factory = new HistoryRecordFactory(allocation);
  const run = factory.run(runId, input, null);
  const session = factory.session(allocatedId(allocation), input, { status: "open", run });
  assertHistoryTransition(null, session, {
    actor: allocation.actor,
    operation: "session.start",
    newRunId: runId,
    beforeSessions: [],
    afterSessions: [session],
    beforeCheckpoints: [],
    afterCheckpoints: [],
  });
  return { result: session, owner: session, effects: entityCommandEffect(null, session) };
}

/**
 * Чисто открывает новое участие, наследуя только оператора участия создателя ребёнка.
 */
function connectHistorySession(
  session: HistorySession,
  input: Extract<HistoryTransition, { action: "attach" | "resume" | "takeover" }>,
  state: HistoryCommandState,
  allocation: HistoryAllocation,
): void {
  checkHistoryConnectionState(session, input);
  if (input.action === "takeover") {
    endHistoryRun(session, "transferred", input.reason, allocation.now);
  }
  const run = new HistoryRecordFactory(allocation).run(
    allocatedId(allocation),
    input,
    session.data.runs.at(-1)?.id ?? null,
  );
  if (input.action === "attach" && input.operator === undefined) {
    const parent = state.sessions.find((entry) => entry.id === session.data.parentSessionId);
    const intent = state.checkpoints.find((entry) => entry.id === session.data.originCheckpointId);
    if (parent === undefined || intent === undefined) {
      historyConflict(historyStateMessages.creatorRunMissing);
    }
    assertHistoryChildOrigin(session, parent, intent);
    const creator = parent.data.runs.find((entry) => entry.id === session.data.createdByRunId);
    if (creator === undefined) {
      historyConflict(historyStateMessages.creatorRunMissing);
    }
    run.operator = creator.operator === null ? null : { ...creator.operator, source: "inherited" };
  }
  session.data.runs.push(run);
  session.data.currentRunId = run.id;
  session.data.status = "open";
}

/**
 * Рассчитывает точный переход сессии либо child+parent fork. Входные записи не меняются.
 * CAS проверяется до состояния; единый transition validator защищает полученный эффект.
 */
export function calculateHistoryTransition(
  state: HistoryCommandState,
  input: HistoryTransition,
  write: Readonly<WriteOptions>,
  allocation: HistoryAllocation,
): HistoryCommandDelta<HistorySession> {
  const before = state.session;
  checkHistoryRevision(before, write.ifRevision);
  if (!unfinishedSession(before)) {
    historyConflict(historyStateMessages.closedSession);
  }
  const owner = nextSession(before, allocation);
  let result = owner;
  if (input.action === "fork") {
    const intent = state.intent;
    if (intent === null) {
      invalidHistoryInput(historyInputMessages.intentRequired);
    }
    const run = checkHistoryOwner(before, input.runId, write.actor);
    checkOpenHistoryIntent(intent, state.checkpoints);
    result = new HistoryRecordFactory(allocation).session(allocatedId(allocation), input, {
      status: "pending",
      parentSessionId: before.id,
      originCheckpointId: intent.id,
      createdByRunId: run.id,
    });
  } else if (
    input.action === "attach" ||
    input.action === "resume" ||
    input.action === "takeover"
  ) {
    connectHistorySession(owner, input, state, allocation);
  } else if (input.action === "pause") {
    checkHistoryOwner(before, input.runId, write.actor);
    endHistoryRun(owner, "paused", input.reason, allocation.now);
    owner.data.status = "paused";
  } else if (input.action === "complete" || input.action === "cancel") {
    if (input.action === "complete" || before.data.status === "open") {
      checkHistoryOwner(before, input.runId, write.actor);
    } else if (input.runId !== null) {
      invalidHistoryInput(historyInputMessages.inactiveRunForbidden);
    }
    const status = input.action === "complete" ? "completed" : "cancelled";
    if (owner.data.currentRunId !== null) {
      endHistoryRun(owner, status, input.result, allocation.now);
    }
    owner.data.status = status;
    owner.data.result = input.result;
    owner.data.closedAt = allocation.now;
  }
  const context = transitionContext(
    state,
    owner,
    result,
    `session.${input.action}`,
    write.actor,
    ["attach", "resume", "takeover"].includes(input.action) ? allocation.id : null,
  );
  if (result.id !== owner.id) {
    assertHistoryTransition(null, result, context);
  }
  assertHistoryTransition(before, owner, context);
  return {
    result,
    owner,
    effects: [
      ...(result.id === owner.id ? [] : entityCommandEffect(null, result)),
      ...entityCommandEffect(before, owner),
    ],
  };
}

/**
 * Рассчитывает append-only материал и точное повышение владельца; sequence и снимки не финализируются повторно.
 */
export function calculateHistoryCheckpoint(
  state: HistoryCommandState,
  action: HistoryCheckpointAction,
  input: HistoryCheckpointValues,
  write: Readonly<WriteOptions>,
  allocation: HistoryAllocation,
): HistoryCommandDelta<HistoryCheckpoint> {
  checkHistoryRevision(state.session, write.ifRevision);
  const run = checkHistoryOwner(state.session, input.runId, write.actor);
  const result = new HistoryRecordFactory(allocation).checkpoint(allocatedId(allocation), {
    action,
    values: input,
    session: state.session,
    run,
    intentId: state.intent?.id ?? null,
    materials: state.checkpoints,
    references: snapshotHistoryReferences(
      state.references.records,
      state.references.projectId,
      state.references.project,
    ),
  });
  const owner = nextSession(state.session, allocation);
  const context = transitionContext(state, owner, result, `checkpoint.${action}`, write.actor);
  assertHistoryTransition(null, result, context);
  assertHistoryTransition(state.session, owner, context);
  return {
    result,
    owner,
    effects: [...entityCommandEffect(null, result), ...entityCommandEffect(state.session, owner)],
  };
}
