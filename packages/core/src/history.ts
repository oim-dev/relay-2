import {
  validateActor,
  type HistoryCheckpoint,
  type HistoryCheckpointAction,
  type HistoryContext,
  type HistoryReference,
  type HistoryRun,
  type HistorySession,
  type HistorySessionData,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "./entities";
import { EntityReader } from "./entity-reader";
import { decodeHistoryCheckpoint, decodeHistorySession } from "./history-data";
import {
  historyCheckpointInput,
  historyFilters,
  historyStartInput,
  historyTransitionInput,
  historyWriteOptions,
  invalidHistoryInput,
  type HistoryConnection,
  type HistorySessionContent,
  type HistoryTransition,
} from "./history-input";
import {
  checkHistoryAcceptance,
  checkHistoryChildrenClosure,
  checkHistoryOwner,
  checkHistoryRevision,
  checkOpenHistoryIntent,
  endHistoryRun,
  historyConflict,
  historySubtree,
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

/** Оркестрация истории: декодированные чтения и атомарная запись материалов и ответственности. */
export class HistoryService {
  private readonly entities: EntityService;

  constructor(private readonly db: ProjectDatabase) {
    this.entities = new EntityService(db);
  }

  get(ref: string): HistorySession {
    return decodeHistorySession(this.entities.get(ref, "work-session"));
  }

  getCheckpoint(ref: string): HistoryCheckpoint {
    return decodeHistoryCheckpoint(this.entities.get(ref, "work-checkpoint"));
  }

  list(filters: unknown = {}): HistorySession[] {
    return this.db.snapshot(() => {
      const input = historyFilters(filters);
      const parent = typeof input.parent === "string" ? this.get(input.parent).id : input.parent;
      return this.sessions()
        .filter(
          (session) =>
            (input.status === undefined || session.data.status === input.status) &&
            (input.unfinished === undefined || unfinishedSession(session) === input.unfinished) &&
            (parent === undefined || session.data.parentSessionId === parent) &&
            (input.actor === null || session.data.runs.some((run) => run.actor === input.actor)) &&
            (input.query === null ||
              [session.key, session.data.title, session.data.description ?? ""]
                .join("\n")
                .toLocaleLowerCase()
                .includes(input.query)),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    });
  }

  /** Создаёт корневую сессию и её первое активное участие одной записью. Автор сохраняется дословно. */
  start(input: unknown, actor: string): HistorySession {
    return this.db.transaction(() => {
      const values = historyStartInput(input);
      const author = validateActor(actor);
      const now = new Date().toISOString();
      const run = this.newRun(values, author, now, null);
      const session = this.newSession(values, author, now, {
        status: "open",
        currentRunId: run.id,
        runs: [run],
      });
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
  transition(ref: string, action: string, input: unknown, options: WriteOptions): HistorySession {
    return this.db.transaction(() => {
      const write = historyWriteOptions(options);
      const values = historyTransitionInput(action, input);
      if (values.action === "fork") return this.fork(ref, values, write);
      const session = this.get(ref);
      checkHistoryRevision(session, write.ifRevision);
      if (!unfinishedSession(session))
        historyConflict("Завершённая или отменённая сессия неизменяема.");
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
    options: WriteOptions,
  ): HistoryCheckpoint {
    return this.db.transaction(() => {
      const write = historyWriteOptions(options);
      const values = historyCheckpointInput(action, input);
      const intent = action === "open" ? null : this.getCheckpoint(ref);
      const session = intent === null ? this.get(ref) : this.get(intent.data.sessionId);
      checkHistoryRevision(session, write.ifRevision);
      const run = checkHistoryOwner(session, values.runId, write.actor);
      const materials = this.checkpoints();
      if (intent !== null) {
        checkOpenHistoryIntent(intent, materials);
        checkHistoryAcceptance(
          session.id,
          intent.id,
          this.acceptedSessions(values.acceptedSessionIds),
        );
        if (action === "complete" || action === "cancel") {
          checkHistoryChildrenClosure(
            session.id,
            intent.id,
            values.acceptedSessionIds,
            this.sessions(),
            materials,
          );
        }
      }
      const now = new Date().toISOString();
      const id = this.newId();
      const checkpoint: HistoryCheckpoint = {
        id,
        key: `CP-${id}`,
        kind: "work-checkpoint",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: write.actor,
        updatedBy: write.actor,
        data: {
          ...values,
          kind:
            action === "open"
              ? "intent"
              : action === "save"
                ? "progress"
                : action === "complete"
                  ? "result"
                  : "cancel",
          sessionId: session.id,
          runId: run.id,
          actor: run.actor,
          intentId: intent?.id ?? null,
          sequence:
            materials
              .filter((entry) => entry.data.sessionId === session.id)
              .reduce((max, entry) => Math.max(max, entry.data.sequence), 0) + 1,
          sessionRevision: session.revision + 1,
          references: this.references(values.references),
        },
      };
      this.db.insert(checkpoint);
      this.saveSession(session, write, now);
      return checkpoint;
    });
  }

  history(ref?: string): HistoryCheckpoint[] {
    return this.db.snapshot(() => {
      const sessionId = ref === undefined ? undefined : this.get(ref).id;
      return this.checkpoints()
        .filter((entry) => sessionId === undefined || entry.data.sessionId === sessionId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) ||
            a.data.sequence - b.data.sequence ||
            a.id.localeCompare(b.id),
        );
    });
  }

  tree(ref: string): HistorySession[] {
    return this.db.snapshot(() => historySubtree(this.get(ref), this.sessions()));
  }

  intents(ref: string, includeChildren = false): HistoryCheckpoint[] {
    return this.db.snapshot(() => {
      if (typeof includeChildren !== "boolean")
        invalidHistoryInput("includeChildren: ожидается boolean.");
      const session = this.get(ref);
      const sessionIds = new Set(
        (includeChildren ? historySubtree(session, this.sessions()) : [session]).map(
          (entry) => entry.id,
        ),
      );
      const history = this.history().filter((entry) => sessionIds.has(entry.data.sessionId));
      const closed = new Set(
        history
          .filter((entry) => entry.data.kind === "result" || entry.data.kind === "cancel")
          .map((entry) => entry.data.intentId),
      );
      return history.filter((entry) => entry.data.kind === "intent" && !closed.has(entry.id));
    });
  }

  context(ref: string): HistoryContext {
    return this.db.snapshot(() => {
      const session = this.get(ref);
      return {
        session,
        checkpoints: this.history(session.id),
        intents: this.intents(session.id),
        children: this.sessions().filter((entry) => entry.data.parentSessionId === session.id),
      };
    });
  }

  private sessions(): HistorySession[] {
    return this.db.list("work-session").map(decodeHistorySession);
  }

  private checkpoints(): HistoryCheckpoint[] {
    return this.db.list("work-checkpoint").map(decodeHistoryCheckpoint);
  }

  private newId(): string {
    const runs = new Set(
      this.sessions().flatMap((session) => session.data.runs.map((run) => run.id)),
    );
    let id: string;
    do {
      id = crypto.randomUUID();
    } while (
      this.db.get(id) !== undefined ||
      this.db.get(`S-${id}`) !== undefined ||
      this.db.get(`CP-${id}`) !== undefined ||
      this.db.get(`RUN-${id}`) !== undefined ||
      runs.has(id)
    );
    return id;
  }

  private newRun(
    input: HistoryConnection,
    actor: string,
    now: string,
    predecessorRunId: string | null,
  ): HistoryRun {
    const id = this.newId();
    return {
      id,
      key: `RUN-${id}`,
      actor,
      state: "active",
      reason: input.reason,
      operator: input.operator ?? null,
      client: input.client,
      sourceSessionId: input.sourceSessionId,
      predecessorRunId,
      startedAt: now,
      endedAt: null,
      endReason: null,
    };
  }

  private newSession(
    input: HistorySessionContent,
    actor: string,
    now: string,
    state: Partial<HistorySessionData>,
  ): HistorySession {
    let id = this.newId();
    while (state.runs?.some((run) => run.id === id)) id = this.newId();
    return {
      id,
      key: `S-${id}`,
      kind: "work-session",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
      data: {
        title: input.title,
        description: input.description,
        status: "pending",
        currentRunId: null,
        runs: [],
        parentSessionId: null,
        originCheckpointId: null,
        createdByRunId: null,
        result: null,
        closedAt: null,
        ...state,
      },
    };
  }

  private saveSession(session: HistorySession, options: WriteOptions, now: string): HistorySession {
    session.revision += 1;
    session.updatedAt = now;
    session.updatedBy = options.actor;
    this.db.update(session, options.ifRevision);
    return session;
  }

  private connect(
    session: HistorySession,
    input: Extract<HistoryTransition, { action: "attach" | "resume" | "takeover" }>,
    actor: string,
    now: string,
  ): void {
    const expected =
      input.action === "attach" ? "pending" : input.action === "resume" ? "paused" : "open";
    if (session.data.status !== expected)
      historyConflict(`Действие ${input.action} требует состояния ${expected}.`);
    if (input.action === "takeover") endHistoryRun(session, "transferred", input.reason, now);
    const run = this.newRun(input, actor, now, session.data.runs.at(-1)?.id ?? null);
    if (input.action === "attach" && input.operator === undefined) {
      const parent = this.get(session.data.parentSessionId!);
      const creator = parent.data.runs.find((entry) => entry.id === session.data.createdByRunId);
      if (!creator) historyConflict("Не найдено участие, создавшее дочернее поручение.");
      run.operator = creator.operator ? { ...creator.operator, source: "inherited" } : null;
    }
    session.data.runs.push(run);
    session.data.currentRunId = run.id;
    session.data.status = "open";
  }

  private close(
    session: HistorySession,
    input: Extract<HistoryTransition, { action: "complete" | "cancel" }>,
    actor: string,
    now: string,
  ): void {
    if (input.action === "complete" || session.data.status === "open") {
      checkHistoryOwner(session, input.runId, actor);
    } else if (input.runId !== null) {
      invalidHistoryInput("У pending/paused-сессии нет текущего run; не передавайте runId.");
    }
    if (this.intents(session.id).length > 0)
      historyConflict("Сначала закройте все намерения сессии.");
    checkHistoryChildrenClosure(session.id, null, [], this.sessions(), this.checkpoints());
    const status = input.action === "complete" ? "completed" : "cancelled";
    if (session.data.currentRunId !== null) endHistoryRun(session, status, input.result, now);
    session.data.status = status;
    session.data.result = input.result;
    session.data.closedAt = now;
  }

  private fork(
    ref: string,
    input: Extract<HistoryTransition, { action: "fork" }>,
    options: WriteOptions,
  ): HistorySession {
    const intent = this.getCheckpoint(ref);
    const parent = this.get(intent.data.sessionId);
    checkHistoryRevision(parent, options.ifRevision);
    const run = checkHistoryOwner(parent, input.runId, options.actor);
    checkOpenHistoryIntent(intent, this.checkpoints());
    const now = new Date().toISOString();
    const child = this.newSession(input, options.actor, now, {
      parentSessionId: parent.id,
      originCheckpointId: intent.id,
      createdByRunId: run.id,
    });
    this.db.insert(child);
    this.saveSession(parent, options, now);
    return child;
  }

  private references(references: string[]): HistoryReference[] {
    const ids = new Set<string>();
    const reader = new EntityReader(this.db);
    return references.map((reference) => {
      const target = reader.get(reference);
      if (ids.has(target.id)) invalidHistoryInput("references: одна запись указана несколько раз.");
      ids.add(target.id);
      let title: string;
      switch (target.kind) {
        case "product":
          title = target.data.name ?? target.key;
          break;
        case "project":
        case "feature":
        case "scenario":
        case "application":
        case "board":
        case "document":
          title = target.data.name;
          break;
        default:
          title = target.data.title;
      }
      return { id: target.id, kind: target.kind, key: target.key, title };
    });
  }

  private acceptedSessions(ids: string[]): HistorySession[] {
    return ids.map((id) => {
      const child = this.get(id);
      if (child.id !== id)
        invalidHistoryInput("acceptedSessionIds принимает постоянные ID, а не ключи или адреса.");
      return child;
    });
  }
}
