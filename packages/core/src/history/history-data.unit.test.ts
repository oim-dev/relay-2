import { describe, expect, test } from "bun:test";
import {
  RelayError,
  type EntityRecord,
  type HistoryCheckpoint,
  type HistorySession,
} from "@relay/contracts";
import { decodeHistoryCheckpoint, decodeHistorySession } from "./history-data";
import type { HistoryCorruptionCase } from "./history-data-test.types";

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

const sessionCorruptions = [
  { name: "отсутствующий массив", dataPatch: { runs: undefined } },
  { name: "null вместо массива", dataPatch: { runs: null } },
  { name: "пустой элемент", dataPatch: { runs: [null] } },
  {
    name: "неполное участие",
    dataPatch: { runs: [{ id: "run", actor: "агент", state: "active" }] },
  },
  {
    name: "неизвестное состояние",
    dataPatch: { runs: [{ ...session.data.runs[0], state: "unknown" }] },
  },
  {
    name: "некорректный автор",
    dataPatch: { runs: [{ ...session.data.runs[0], actor: "агент\u0000" }] },
  },
  {
    name: "неполный пользователь",
    dataPatch: { runs: [{ ...session.data.runs[0], operator: { source: "explicit" } }] },
  },
  {
    name: "активное участие с датой завершения",
    dataPatch: { runs: [{ ...session.data.runs[0], endedAt: timestamp }] },
  },
  {
    name: "чужой predecessor",
    dataPatch: { runs: [{ ...session.data.runs[0], predecessorRunId: "other" }] },
  },
  { name: "несуществующий текущий run", dataPatch: { currentRunId: "missing" } },
  { name: "пауза с активным run", dataPatch: { status: "paused", currentRunId: null } },
  { name: "несогласованное происхождение", dataPatch: { parentSessionId: "parent" } },
  { name: "отсутствующий nullable-текст", dataPatch: { description: undefined } },
] satisfies readonly HistoryCorruptionCase[];

const checkpointCorruptions = [
  { name: "нет references", dataPatch: { references: undefined } },
  { name: "неполная ссылка", dataPatch: { references: [{ id: "target", kind: "document" }] } },
  {
    name: "неизвестный вид ссылки",
    dataPatch: { references: [{ id: "target", key: "DOC-1", title: "Документ", kind: "other" }] },
  },
  { name: "null вместо принятия", dataPatch: { acceptedSessionIds: null } },
  {
    name: "нестроковый ID принятия",
    // У progress приёмка разрешена: запрет приёмки у intent не должен маскировать неверный ID.
    dataPatch: { kind: "progress", intentId: "original-intent", acceptedSessionIds: [1] },
  },
  { name: "дробный порядок", dataPatch: { sequence: 1.5 } },
  { name: "нулевая ревизия сессии", dataPatch: { sessionRevision: 0 } },
  { name: "progress без intent", dataPatch: { kind: "progress" } },
  { name: "пустой материал", dataPatch: { body: "  " } },
  { name: "неверный nullable-текст", dataPatch: { summary: {} } },
] satisfies readonly HistoryCorruptionCase[];

/**
 * Подтверждает предметный отказ декодера, исключая успех или постороннюю ошибку JavaScript.
 */
function expectCorruptHistory(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ code: "CORRUPT_DATA" });
    return;
  }
  throw new Error("Ожидалась ошибка CORRUPT_DATA.");
}

describe("Декодирование сохранённой сессии истории", () => {
  test.each(sessionCorruptions)("$name отклоняется как CORRUPT_DATA", ({ dataPatch }) => {
    const corruptedRecord: EntityRecord = structuredClone({
      ...session,
      data: { ...session.data, ...dataPatch },
    });

    expectCorruptHistory(() => decodeHistorySession(corruptedRecord));
  });

  test("валидные null и активное участие сохраняются без подмены", () => {
    const record = structuredClone(session);

    const decoded = decodeHistorySession(record);

    expect(decoded).toEqual(session);
  });
});

describe("Декодирование сохранённого материала истории", () => {
  test.each(checkpointCorruptions)("$name отклоняется как CORRUPT_DATA", ({ dataPatch }) => {
    const corruptedRecord: EntityRecord = structuredClone({
      ...intent,
      data: { ...intent.data, ...dataPatch },
    });

    expectCorruptHistory(() => decodeHistoryCheckpoint(corruptedRecord));
  });

  test("валидные null и пробелы материала сохраняются без нормализации", () => {
    const record = structuredClone(intent);

    const decoded = decodeHistoryCheckpoint(record);

    expect(decoded).toEqual(intent);
  });
});
