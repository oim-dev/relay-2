import type {
  HistoryCheckpoint,
  HistoryRun,
  HistorySession,
  HistorySessionData,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
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
 * Создаёт новые записи истории без сохранения, резервируя ID на время одной транзакции.
 * Набор существующих участий загружается вызывающим сценарием один раз; фабрика не переживает
 * операцию и не заменяет атомарную вставку и CAS сессии в HistoryService.
 */
export class HistoryRecordFactory {
  /* БД того же снимка операции для проверки занятых ID, ключей и алиасов. */
  private readonly db: ProjectDatabase;
  /* Проверенный автор и единое время создания записей операции. */
  private readonly metadata: HistoryRecordMetadata;
  /* ID существующих участий и уже выданные ID этой операции. */
  private readonly reservedIds: Set<string>;

  /**
   * Создаёт локальный резерв ID из декодированных сессий текущей транзакции.
   */
  constructor(
    db: ProjectDatabase,
    sessions: readonly HistorySession[],
    metadata: HistoryRecordMetadata,
  ) {
    this.db = db;
    this.metadata = metadata;
    this.reservedIds = new Set(
      sessions.flatMap((session) => session.data.runs.map((run) => run.id)),
    );
  }

  /**
   * Выдаёт ID без пересечения с адресами записей, участиями и ранее созданными объектами операции.
   */
  private newId(): string {
    let id: string;
    do {
      id = crypto.randomUUID();
    } while (
      this.reservedIds.has(id) ||
      this.db.get(id) !== undefined ||
      this.db.get(`S-${id}`) !== undefined ||
      this.db.get(`CP-${id}`) !== undefined ||
      this.db.get(`RUN-${id}`) !== undefined
    );
    this.reservedIds.add(id);
    return id;
  }

  /**
   * Создаёт активное участие; наследование operator при attach выполняет сценарий подключения.
   */
  run(input: HistoryConnection, predecessorRunId: string | null): HistoryRun {
    const id = this.newId();
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
  session(input: HistorySessionContent, state: HistorySessionInitialization): HistorySession {
    const id = this.newId();
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
      data.runs = [state.run];
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
  checkpoint(input: HistoryCheckpointCreation): HistoryCheckpoint {
    const id = this.newId();
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
        references: [...input.references],
        acceptedSessionIds: [...input.values.acceptedSessionIds],
      },
    };
  }
}
