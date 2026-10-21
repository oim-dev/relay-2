import { expect, test } from "bun:test";
import {
  RelayError,
  type EntityRecord,
  type HistoryCheckpoint,
  type HistorySession,
} from "@relay/contracts";
import { decodeHistoryCheckpoint, decodeHistorySession } from "./history-data";

const timestamp = "2026-10-21T00:00:00.000Z";
const session: HistorySession = {
  id: "session",
  key: "S-session",
  kind: "work-session",
  revision: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: "агент",
  updatedBy: "агент",
  data: {
    title: "Исследовать контракт",
    description: null,
    status: "open",
    currentRunId: "run",
    runs: [
      {
        id: "run",
        key: "RUN-run",
        actor: "агент",
        state: "active",
        reason: null,
        operator: null,
        client: null,
        sourceSessionId: null,
        predecessorRunId: null,
        startedAt: timestamp,
        endedAt: null,
        endReason: null,
      },
    ],
    parentSessionId: null,
    originCheckpointId: null,
    createdByRunId: null,
    result: null,
    closedAt: null,
  },
};
const intent: HistoryCheckpoint = {
  id: "intent",
  key: "CP-intent",
  kind: "work-checkpoint",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: "агент",
  updatedBy: "агент",
  data: {
    kind: "intent",
    sessionId: session.id,
    runId: "run",
    actor: "агент",
    intentId: null,
    sequence: 1,
    sessionRevision: 2,
    title: "Проверить контракт",
    body: "  Основания\n",
    summary: null,
    done: null,
    remaining: null,
    nextStep: null,
    checks: null,
    references: [],
    acceptedSessionIds: [],
  },
};

function corrupt(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ code: "CORRUPT_DATA" });
    return;
  }
  throw new Error("Ожидалась ошибка CORRUPT_DATA.");
}

test.each([
  ["отсутствующий массив", { runs: undefined }],
  ["null вместо массива", { runs: null }],
  ["пустой элемент", { runs: [null] }],
  ["неполное участие", { runs: [{ id: "run", actor: "агент", state: "active" }] }],
  ["неизвестное состояние", { runs: [{ ...session.data.runs[0], state: "unknown" }] }],
  ["некорректный автор", { runs: [{ ...session.data.runs[0], actor: "агент\u0000" }] }],
  [
    "неполный пользователь",
    { runs: [{ ...session.data.runs[0], operator: { source: "explicit" } }] },
  ],
  [
    "активное участие с датой завершения",
    { runs: [{ ...session.data.runs[0], endedAt: timestamp }] },
  ],
  ["чужой predecessor", { runs: [{ ...session.data.runs[0], predecessorRunId: "other" }] }],
  ["несуществующий текущий run", { currentRunId: "missing" }],
  ["пауза с активным run", { status: "paused", currentRunId: null }],
  ["несогласованное происхождение", { parentSessionId: "parent" }],
  ["отсутствующий nullable-текст", { description: undefined }],
] satisfies [string, Record<string, unknown>][])(
  "сессия: %s является повреждением, а не допустимым отсутствием",
  (_label, patch) => {
    const damaged: EntityRecord = { ...session, data: { ...session.data, ...patch } };
    corrupt(() => decodeHistorySession(damaged));
  },
);

test.each([
  ["нет references", { references: undefined }],
  ["неполная ссылка", { references: [{ id: "target", kind: "document" }] }],
  [
    "неизвестный вид ссылки",
    { references: [{ id: "target", key: "DOC-1", title: "Документ", kind: "other" }] },
  ],
  ["null вместо принятия", { acceptedSessionIds: null }],
  ["нестроковый ID принятия", { acceptedSessionIds: [1] }],
  ["дробный порядок", { sequence: 1.5 }],
  ["нулевая ревизия сессии", { sessionRevision: 0 }],
  ["progress без intent", { kind: "progress" }],
  ["пустой материал", { body: "  " }],
  ["неверный nullable-текст", { summary: {} }],
] satisfies [string, Record<string, unknown>][])(
  "checkpoint: %s отвергается декодером",
  (_label, patch) => {
    corrupt(() => decodeHistoryCheckpoint({ ...intent, data: { ...intent.data, ...patch } }));
  },
);

test("декодирование сохраняет валидные null и материал без нормализации", () => {
  expect(decodeHistorySession(session)).toEqual(session);
  expect(decodeHistoryCheckpoint(intent)).toEqual(intent);
});
