import type {
  HistoryCheckpoint,
  HistoryRun,
  HistorySession,
  HistorySessionData,
} from "@relay/contracts";
import type { HistoryConnection, HistorySessionContent } from "./history-input.types";
import type {
  HistoryCheckpointCreation,
  HistoryRecordMetadata,
  HistorySessionInitialization,
} from "./history-records.types";

const checkpointKinds = {
  open: "intent",
  save: "progress",
  complete: "result",
  cancel: "cancel",
} as const;

/**
 * Чисто создаёт записи из проверенных значений и заранее выделенных метаданных.
 * Не получает хранилище, не читает часы, не выделяет ID и не меняет входные объекты.
 */
export class HistoryRecordFactory {
  /* Проверенный автор и единое время создания записей операции. */
  private readonly metadata: HistoryRecordMetadata;

  /**
   * Фиксирует проверенные авторство и время без побочных эффектов.
   */
  constructor(metadata: HistoryRecordMetadata) {
    this.metadata = metadata;
  }

  /**
   * Создаёт активное участие; наследование operator при attach выполняет сценарий подключения.
   */
  run(id: string, input: HistoryConnection, predecessorRunId: string | null): HistoryRun {
    return {
      id,
      key: `RUN-${id}`,
      actor: this.metadata.actor,
      state: "active",
      reason: input.reason,
      operator: input.operator == null ? null : { ...input.operator },
      client: input.client,
      sourceSessionId: input.sourceSessionId,
      predecessorRunId,
      startedAt: this.metadata.now,
      endedAt: null,
      endReason: null,
    };
  }

  /**
   * Создаёт корень с первым участием либо pending-ребёнка с полной тройкой происхождения.
   * Начальная ревизия равна 1; метод не записывает данные и не меняет входные объекты.
   */
  session(
    id: string,
    input: HistorySessionContent,
    state: HistorySessionInitialization,
  ): HistorySession {
    const data: HistorySessionData = {
      title: input.title,
      description: input.description,
      status: state.status,
      currentRunId: null,
      runs: [],
      parentSessionId: null,
      originCheckpointId: null,
      createdByRunId: null,
      result: null,
      closedAt: null,
    };
    if (state.status === "open") {
      data.currentRunId = state.run.id;
      data.runs = [structuredClone(state.run)];
    } else {
      data.parentSessionId = state.parentSessionId;
      data.originCheckpointId = state.originCheckpointId;
      data.createdByRunId = state.createdByRunId;
    }
    return {
      id,
      key: `S-${id}`,
      kind: "work-session",
      revision: 1,
      createdAt: this.metadata.now,
      updatedAt: this.metadata.now,
      createdBy: this.metadata.actor,
      updatedBy: this.metadata.actor,
      data,
    };
  }

  /**
   * Создаёт новый материал с revision=1 и следующей ревизией сессии-владельца.
   * Порядок вычисляется только по материалам этой сессии; исходный intent не изменяется.
   */
  checkpoint(id: string, input: HistoryCheckpointCreation): HistoryCheckpoint {
    return {
      id,
      key: `CP-${id}`,
      kind: "work-checkpoint",
      revision: 1,
      createdAt: this.metadata.now,
      updatedAt: this.metadata.now,
      createdBy: this.metadata.actor,
      updatedBy: this.metadata.actor,
      data: {
        ...input.values,
        kind: checkpointKinds[input.action],
        sessionId: input.session.id,
        runId: input.run.id,
        actor: input.run.actor,
        intentId: input.intentId,
        sequence:
          input.materials.reduce(
            (max, entry) =>
              entry.data.sessionId === input.session.id ? Math.max(max, entry.data.sequence) : max,
            0,
          ) + 1,
        sessionRevision: input.session.revision + 1,
        references: input.references.map((reference) => ({ ...reference })),
        acceptedSessionIds: [...input.values.acceptedSessionIds],
      },
    };
  }
}
