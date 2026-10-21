import {
  validateActor,
  type HistoryCheckpoint,
  type HistoryCheckpointAction,
  type HistoryContext,
  type HistorySession,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import {
  historyCheckpointInput,
  historyStartInput,
  historyTransitionInput,
  historyWriteOptions,
  invalidHistoryInput,
} from "./history-input";
import type {
  HistoryCloseTransition,
  HistoryConnectTransition,
  HistoryForkTransition,
} from "./history-input.types";
import { historyInputMessages, historyStateMessages } from "./history-messages";
import { HistoryReader } from "./history-reader";
import { HistoryRecordFactory } from "./history-records";
import {
  checkHistoryAcceptance,
  checkHistoryChildrenClosure,
  checkHistoryConnectionState,
  checkHistoryOwner,
  checkHistoryRevision,
  checkOpenHistoryIntent,
  endHistoryRun,
  historyConflict,
  openHistoryIntents,
  unfinishedSession,
} from "./history-rules";

export type {
  HistorySessionStatus,
  HistoryCheckpointKind,
  HistoryOperator,
  HistoryRun,
  HistorySessionData,
  HistoryReference,
  HistoryCheckpointData,
  HistorySession,
  HistoryCheckpoint,
} from "@relay/contracts";

/**
 * Предметные сценарии истории: согласованные чтения и атомарная запись материалов и ответственности.
 * Все проверки и связанные записи выполняются в одной транзакции проекта; читатель и фабрика
 * не открывают независимые транзакции записи и не владеют временем жизни БД.
 */
export class HistoryService {
  /* БД проекта для общей транзакции проверки состояния и записи. */
  private readonly db: ProjectDatabase;
  /* Декодированные запросы и разрешение ссылок истории без межоперационного кеша. */
  private readonly reader: HistoryReader;

  /**
   * Подключает сценарии к открытой БД; закрытие соединения остаётся обязанностью вызывающей стороны.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
    this.reader = new HistoryReader(db);
  }

  /**
   * Возвращает проверенную сессию по ID, ключу или типизированной ссылке одного снимка.
   */
  get(ref: string): HistorySession {
    return this.reader.session(ref);
  }

  /**
   * Возвращает проверенный append-only материал по ссылке, отклоняя повреждённое хранение.
   */
  getCheckpoint(ref: string): HistoryCheckpoint {
    return this.reader.checkpoint(ref);
  }

  /**
   * Фильтрует все сессии одного снимка и возвращает последние изменённые первыми.
   * Полный набор декодируется до фильтрации; повреждённые записи не пропускаются.
   */
  list(filters: unknown = {}): HistorySession[] {
    return this.reader.list(filters);
  }

  /**
   * Создаёт корневую сессию и первое активное участие атомарно с начальной ревизией 1.
   * Автор и содержание сохраняются дословно; повтор создаёт новую сессию и не является no-op.
   */
  start(input: unknown, actor: string): HistorySession {
    return this.db.transaction(() => {
      const values = historyStartInput(input);
      const author = validateActor(actor);
      const now = new Date().toISOString();
      const records = new HistoryRecordFactory(this.db, this.reader.sessions(), {
        actor: author,
        now,
      });
      const run = records.run(values, null);
      const session = records.session(values, { status: "open", run });
      this.db.insert(session);
      return session;
    });
  }

  /**
   * Меняет состояние и участие с CAS по сессии. Для fork ref указывает на открытый intent,
   * ifRevision принадлежит родительской сессии: создаётся pending-ребёнок и повышается ревизия родителя.
   * Для attach ref/ifRevision принадлежат ребёнку; создаётся его run, а operator при отсутствии ввода
   * наследуется из участия создателя в родителе (родитель не меняется).
   * pause/complete и cancel открытой сессии требуют текущий runId и совпадение автора.
   * takeover закрывает прежний run и создаёт новый; завершение требует закрытых намерений и детей.
   * Повтор не является no-op. Конфликты состояния/владения, REVISION_CONFLICT и CORRUPT_DATA
   * не оставляют частичных записей: все изменения и поколение откатываются вместе.
   */
  transition(
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): HistorySession {
    return this.db.transaction(() => {
      const write = historyWriteOptions(options);
      const values = historyTransitionInput(action, input);
      if (values.action === "fork") {
        return this.fork(ref, values, write);
      }
      const session = this.get(ref);
      checkHistoryRevision(session, write.ifRevision);
      if (!unfinishedSession(session)) {
        historyConflict(historyStateMessages.closedSession);
      }
      const now = new Date().toISOString();
      if (
        values.action === "attach" ||
        values.action === "resume" ||
        values.action === "takeover"
      ) {
        this.connect(session, values, write.actor, now);
      } else if (values.action === "pause") {
        checkHistoryOwner(session, values.runId, write.actor);
        endHistoryRun(session, "paused", values.reason, now);
        session.data.status = "paused";
      } else if (values.action === "complete" || values.action === "cancel") {
        this.close(session, values, write.actor, now);
      }
      return this.saveSession(session, write, now);
    });
  }

  /**
   * Добавляет неизменяемый материал: open принимает ссылку сессии, остальные действия — исходного intent.
   * ifRevision всегда принадлежит сессии, а не checkpoint. Требуются активный runId и его автор.
   * Новый checkpoint (revision=1) и увеличение ревизии сессии записываются атомарно;
   * sessionRevision результата содержит новую ревизию сессии. Исходный intent не изменяется.
   * save может записать новый материал того же содержания, no-op отсутствует. Закрытый intent,
   * чужой run, непринятые дети, неверная ревизия или повреждённая история вызывают отказ
   * с полным откатом записей и поколения. references сохраняются снимками через общий resolver.
   */
  checkpoint(
    ref: string,
    action: HistoryCheckpointAction,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): HistoryCheckpoint {
    return this.db.transaction(() => {
      const write = historyWriteOptions(options);
      const values = historyCheckpointInput(action, input);
      const intent = action === "open" ? null : this.getCheckpoint(ref);
      const session = intent === null ? this.get(ref) : this.get(intent.data.sessionId);
      checkHistoryRevision(session, write.ifRevision);
      const run = checkHistoryOwner(session, values.runId, write.actor);
      const materials = this.reader.checkpoints();
      if (intent !== null) {
        checkOpenHistoryIntent(intent, materials);
        checkHistoryAcceptance(
          session.id,
          intent.id,
          this.reader.acceptedSessions(values.acceptedSessionIds),
        );
      }
      const sessions = this.reader.sessions();
      if (intent !== null && (action === "complete" || action === "cancel")) {
        checkHistoryChildrenClosure(
          session.id,
          intent.id,
          values.acceptedSessionIds,
          sessions,
          materials,
        );
      }
      const now = new Date().toISOString();
      const records = new HistoryRecordFactory(this.db, sessions, { actor: write.actor, now });
      const checkpoint = records.checkpoint({
        action,
        values,
        session,
        run,
        intentId: intent?.id ?? null,
        materials,
        references: this.reader.references(values.references),
      });
      this.db.insert(checkpoint);
      this.saveSession(session, write, now);
      return checkpoint;
    });
  }

  /**
   * Возвращает хронологический журнал сессии либо проекта из одного снимка всех материалов.
   */
  history(ref?: string): HistoryCheckpoint[] {
    return this.reader.history(ref);
  }

  /**
   * Возвращает сессию и всех потомков в ширину; полный набор сессий читается в одном снимке.
   */
  tree(ref: string): HistorySession[] {
    return this.reader.tree(ref);
  }

  /**
   * Возвращает открытые намерения сессии либо её дерева в одном согласованном снимке.
   * По умолчанию учитывается только сессия; includeChildren=true включает всех потомков.
   * Полный журнал загружается до фильтрации; неверный тип флага даёт INVALID_INPUT.
   */
  intents(ref: string, includeChildren = false): HistoryCheckpoint[] {
    return this.reader.intents(ref, { includeChildren });
  }

  /**
   * Возвращает карточку сессии, журнал, открытые намерения и прямых детей одного снимка.
   * Полные наборы материалов и сессий загружаются по одному разу без пагинации.
   */
  context(ref: string): HistoryContext {
    return this.reader.context(ref);
  }

  /**
   * Повышает ревизию изменённого объекта и сохраняет его с исходным CAS внутри общей транзакции.
   * Вызывается после предметных проверок; даже запись материала без нового содержания меняет ревизию.
   */
  private saveSession(
    session: HistorySession,
    options: Readonly<WriteOptions>,
    now: string,
  ): HistorySession {
    session.revision += 1;
    session.updatedAt = now;
    session.updatedBy = options.actor;
    this.db.update(session, options.ifRevision);
    return session;
  }

  /**
   * Подключает новое участие и при attach наследует пользователя исходного создателя ребёнка.
   * Меняет только переданную сессию; запись и откат принадлежат транзакции transition.
   */
  private connect(
    session: HistorySession,
    input: HistoryConnectTransition,
    actor: string,
    now: string,
  ): void {
    checkHistoryConnectionState(session, input);
    if (input.action === "takeover") {
      endHistoryRun(session, "transferred", input.reason, now);
    }
    const records = new HistoryRecordFactory(this.db, this.reader.sessions(), { actor, now });
    const run = records.run(input, session.data.runs.at(-1)?.id ?? null);
    if (input.action === "attach" && input.operator === undefined) {
      run.operator = this.reader.inheritedOperator(session);
    }
    session.data.runs.push(run);
    session.data.currentRunId = run.id;
    session.data.status = "open";
  }

  /**
   * Проверяет право закрытия, намерения и принятие детей по единому набору материалов.
   * Итог и завершение текущего участия меняют только объект; сохранение выполняет transition.
   */
  private close(
    session: HistorySession,
    input: HistoryCloseTransition,
    actor: string,
    now: string,
  ): void {
    if (input.action === "complete" || session.data.status === "open") {
      checkHistoryOwner(session, input.runId, actor);
    } else if (input.runId !== null) {
      invalidHistoryInput(historyInputMessages.inactiveRunForbidden);
    }
    const materials = this.reader.checkpoints();
    const sessionMaterials = materials.filter((entry) => entry.data.sessionId === session.id);
    if (openHistoryIntents(sessionMaterials).length > 0) {
      historyConflict(historyStateMessages.openIntents);
    }
    checkHistoryChildrenClosure(session.id, null, [], this.reader.sessions(), materials);
    const status = input.action === "complete" ? "completed" : "cancelled";
    if (session.data.currentRunId !== null) {
      endHistoryRun(session, status, input.result, now);
    }
    session.data.status = status;
    session.data.result = input.result;
    session.data.closedAt = now;
  }

  /**
   * Создаёт pending-ребёнка открытого intent и повышает ревизию родителя в транзакции transition.
   * CAS и текущий run принадлежат родителю; отказ его записи откатывает вставку ребёнка.
   */
  private fork(
    ref: string,
    input: HistoryForkTransition,
    options: Readonly<WriteOptions>,
  ): HistorySession {
    const intent = this.getCheckpoint(ref);
    const parent = this.get(intent.data.sessionId);
    checkHistoryRevision(parent, options.ifRevision);
    const run = checkHistoryOwner(parent, input.runId, options.actor);
    checkOpenHistoryIntent(intent, this.reader.checkpoints());
    const now = new Date().toISOString();
    const records = new HistoryRecordFactory(this.db, this.reader.sessions(), {
      actor: options.actor,
      now,
    });
    const child = records.session(input, {
      status: "pending",
      parentSessionId: parent.id,
      originCheckpointId: intent.id,
      createdByRunId: run.id,
    });
    this.db.insert(child);
    this.saveSession(parent, options, now);
    return child;
  }
}
