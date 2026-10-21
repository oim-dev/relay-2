import type { EntityKind, EntityRecord } from "./index";

export const historySessionStatuses = [
  "pending",
  "open",
  "paused",
  "completed",
  "cancelled",
] as const;
export const historyCheckpointKinds = ["intent", "progress", "result", "cancel"] as const;
export const historyRunStates = [
  "active",
  "paused",
  "transferred",
  "completed",
  "cancelled",
] as const;
export const historyOperatorSources = ["explicit", "environment", "git", "inherited"] as const;

export type HistorySessionStatus = (typeof historySessionStatuses)[number];
export type HistoryCheckpointKind = (typeof historyCheckpointKinds)[number];

export type HistoryOperator = {
  name: string | null;
  email: string | null;
  source: (typeof historyOperatorSources)[number];
};

export type HistoryRun = {
  id: string;
  key: string;
  actor: string;
  state: (typeof historyRunStates)[number];
  reason: string | null;
  operator: HistoryOperator | null;
  client: string | null;
  sourceSessionId: string | null;
  predecessorRunId: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
};

export type HistorySessionData = {
  title: string;
  description: string | null;
  status: HistorySessionStatus;
  currentRunId: string | null;
  runs: HistoryRun[];
  parentSessionId: string | null;
  originCheckpointId: string | null;
  createdByRunId: string | null;
  result: string | null;
  closedAt: string | null;
};

/** Снимок адреса и названия: последующее изменение цели не меняет материал истории. */
export type HistoryReference = {
  id: string;
  kind: EntityKind;
  key: string;
  title: string;
};

export type HistoryCheckpointData = {
  kind: HistoryCheckpointKind;
  sessionId: string;
  runId: string;
  actor: string;
  intentId: string | null;
  sequence: number;
  /** Ревизия сессии после записи материала; ревизия самого материала всегда равна 1. */
  sessionRevision: number;
  title: string;
  body: string;
  summary: string | null;
  done: string | null;
  remaining: string | null;
  nextStep: string | null;
  checks: string | null;
  references: HistoryReference[];
  acceptedSessionIds: string[];
};

export type HistorySession = Omit<EntityRecord, "kind" | "data"> & {
  kind: "work-session";
  data: HistorySessionData;
};
export type HistoryCheckpoint = Omit<EntityRecord, "kind" | "data"> & {
  kind: "work-checkpoint";
  data: HistoryCheckpointData;
};

export type HistoryContext = {
  session: HistorySession;
  checkpoints: HistoryCheckpoint[];
  intents: HistoryCheckpoint[];
  children: HistorySession[];
};

export type HistoryConnectionInput = {
  client?: string;
  sourceSessionId?: string;
  reason?: string;
  operator?: HistoryOperator | null;
};
export type HistoryStartInput = HistoryConnectionInput & {
  title: string;
  description?: string;
};
export type HistoryForkInput = {
  title: string;
  description?: string;
  runId: string;
};
export type HistoryCheckpointAction = "open" | "save" | "complete" | "cancel";
export type HistoryCheckpointInput = {
  runId: string;
  title: string;
  body: string;
  summary?: string;
  done?: string;
  remaining?: string;
  nextStep?: string;
  checks?: string;
  references?: string[];
  /** Только постоянные ID завершённых прямых детей исходного намерения; недоступно для open. */
  acceptedSessionIds?: string[];
};
