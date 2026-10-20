import {
  RelayError,
  type EntityKind,
  type EntityRecord,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";

export type HistorySessionStatus = "pending" | "open" | "paused" | "completed" | "cancelled";
export type HistoryCheckpointKind = "intent" | "progress" | "result" | "cancel";

export interface HistoryOperator {
  name: string | null;
  email: string | null;
  source: "explicit" | "environment" | "git" | "inherited";
}

export interface HistoryRun {
  id: string;
  key: string;
  actor: string;
  state: "active" | "paused" | "transferred" | "completed" | "cancelled";
  reason: string | null;
  operator: HistoryOperator | null;
  client: string | null;
  sourceSessionId: string | null;
  predecessorRunId: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface HistorySessionData extends Record<string, unknown> {
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
}

export interface HistoryReference {
  id: string;
  kind: EntityKind;
  key: string;
  title: string;
}

export interface HistoryCheckpointData extends Record<string, unknown> {
  kind: HistoryCheckpointKind;
  sessionId: string;
  runId: string;
  actor: string;
  intentId: string | null;
  sequence: number;
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
}

export type HistorySession = EntityRecord & { data: HistorySessionData };
export type HistoryCheckpoint = EntityRecord & { data: HistoryCheckpointData };

const statuses: HistorySessionStatus[] = ["pending", "open", "paused", "completed", "cancelled"];
const connectionFields = ["client", "sourceSessionId", "reason", "operator"];
const materialFields = [
  "runId",
  "title",
  "body",
  "summary",
  "done",
  "remaining",
  "nextStep",
  "checks",
  "references",
];

function invalid(message: string): never {
  throw new RelayError("INVALID_INPUT", message, 2);
}

function conflict(message: string, details?: Record<string, unknown>): never {
  throw new RelayError("CONFLICT", message, 4, details);
}

function object(
  value: unknown,
  allowed: readonly string[],
  label = "Ввод",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label}: ожидается объект.`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid(`${label}: ожидается обычный объект.`);
  }
  const result = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      invalid(`${label}: неизвестное поле ${String(key)}.`);
    }
  }
  return result;
}

function text(value: unknown, label: string, singleLine = false): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${label}: требуется непустой текст.`);
  }
  if (singleLine && /[\r\n]/u.test(value)) invalid(`${label}: требуется одна строка.`);
  return value;
}

function optionalText(value: unknown, label: string, singleLine = false): string | null {
  return value === undefined ? null : text(value, label, singleLine);
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${label}: ожидается массив постоянных ID или ссылок.`);
  const result = Array.from(value, (item) => text(item, label, true));
  if (new Set(result).size !== result.length) invalid(`${label}: повторяющиеся значения.`);
  return result;
}

function operator(value: unknown): HistoryOperator | null {
  if (value === undefined || value === null) return null;
  const input = object(value, ["name", "email", "source"], "operator");
  const source = input.source;
  if (
    source !== "explicit" &&
    source !== "environment" &&
    source !== "git" &&
    source !== "inherited"
  ) {
    invalid("operator.source: неизвестный источник пользователя.");
  }
  return {
    name: input.name === null ? null : optionalText(input.name, "operator.name", true),
    email: input.email === null ? null : optionalText(input.email, "operator.email", true),
    source,
  };
}

function writeOptions(value: unknown): WriteOptions {
  const input = object(value, ["actor", "ifRevision"], "Параметры записи");
  const actor = text(input.actor, "actor", true);
  if (
    typeof input.ifRevision !== "number" ||
    !Number.isSafeInteger(input.ifRevision) ||
    input.ifRevision < 1
  ) {
    invalid("ifRevision: требуется положительная целая ревизия сессии.");
  }
  return { actor, ifRevision: input.ifRevision };
}

function unfinished(session: HistorySession): boolean {
  return !["completed", "cancelled"].includes(session.data.status);
}

/** Предметная история хранит материалы и ответственность, а не действия внешних инструментов. */
export class HistoryService {
  constructor(readonly db: ProjectDatabase) {}

  get(ref: string): HistorySession {
    return this.lookup(ref, "work-session") as HistorySession;
  }

  getCheckpoint(ref: string): HistoryCheckpoint {
    return this.lookup(ref, "work-checkpoint") as HistoryCheckpoint;
  }

  list(filters: Record<string, unknown> = {}): HistorySession[] {
    return this.db.snapshot(() => {
      const input = object(filters, ["status", "unfinished", "parent", "actor", "q"]);
      if (input.status !== undefined && !statuses.includes(input.status as HistorySessionStatus)) {
        invalid("status: неизвестное состояние сессии.");
      }
      if (input.unfinished !== undefined && typeof input.unfinished !== "boolean") {
        invalid("unfinished: ожидается логическое значение.");
      }
      const parent =
        input.parent === undefined || input.parent === null
          ? input.parent
          : this.get(text(input.parent, "parent", true)).id;
      const actor = optionalText(input.actor, "actor", true);
      const query = optionalText(input.q, "q")?.toLocaleLowerCase();
      return this.sessions()
        .filter((session) => {
          return (
            (input.status === undefined || session.data.status === input.status) &&
            (input.unfinished === undefined || unfinished(session) === input.unfinished) &&
            (parent === undefined || session.data.parentSessionId === parent) &&
            (actor === null || session.data.runs.some((run) => run.actor === actor)) &&
            (query === undefined ||
              [session.key, session.data.title, session.data.description ?? ""]
                .join("\n")
                .toLocaleLowerCase()
                .includes(query))
          );
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    });
  }

  start(input: Record<string, unknown>, actor: string): HistorySession {
    return this.db.transaction(() => {
      const values = object(input, ["title", "description", ...connectionFields]);
      const author = text(actor, "actor", true);
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

  transition(
    ref: string,
    action: string,
    input: Record<string, unknown>,
    options: WriteOptions,
  ): HistorySession {
    return this.db.transaction(() => {
      const write = writeOptions(options);
      if (action === "fork") return this.fork(ref, input, write);
      const allowed: Record<string, string[]> = {
        pause: ["runId", "reason"],
        resume: connectionFields,
        takeover: connectionFields,
        complete: ["runId", "result"],
        cancel: ["runId", "result"],
        attach: connectionFields,
      };
      if (typeof action !== "string" || !Object.hasOwn(allowed, action)) {
        invalid("Неизвестное действие сессии.");
      }
      const values = object(input, allowed[action]!);
      const session = this.get(ref);
      this.checkRevision(session, write.ifRevision);
      if (!unfinished(session)) conflict("Завершённая или отменённая сессия неизменяема.");
      const now = new Date().toISOString();

      if (action === "attach" || action === "resume" || action === "takeover") {
        const expected = action === "attach" ? "pending" : action === "resume" ? "paused" : "open";
        if (session.data.status !== expected) {
          conflict(`Действие ${action} требует состояния ${expected}.`);
        }
        if (action === "takeover") {
          const reason = text(values.reason, "reason");
          this.endRun(session, "transferred", reason, now);
        }
        const previous = session.data.runs.at(-1)?.id ?? null;
        const run = this.newRun(values, write.actor, now, previous);
        if (action === "attach" && values.operator === undefined) {
          const parent = this.get(session.data.parentSessionId!);
          const creator = parent.data.runs.find(
            (entry) => entry.id === session.data.createdByRunId,
          );
          if (!creator) conflict("Не найдено участие, создавшее дочернее поручение.");
          run.operator = creator.operator ? { ...creator.operator, source: "inherited" } : null;
        }
        session.data.runs.push(run);
        session.data.currentRunId = run.id;
        session.data.status = "open";
      } else if (action === "pause") {
        this.checkOwner(session, values.runId, write.actor);
        this.endRun(session, "paused", text(values.reason, "reason"), now);
        session.data.status = "paused";
      } else {
        if (action === "complete" || session.data.status === "open") {
          this.checkOwner(session, values.runId, write.actor);
        } else if (values.runId !== undefined) {
          invalid("У pending/paused-сессии нет текущего run; не передавайте runId.");
        }
        const result = text(values.result, "result");
        this.checkSessionClosure(session);
        const status = action === "complete" ? "completed" : "cancelled";
        if (session.data.currentRunId !== null) this.endRun(session, status, result, now);
        session.data.status = status;
        session.data.result = result;
        session.data.closedAt = now;
      }
      return this.saveSession(session, write, now);
    });
  }

  checkpoint(
    ref: string,
    action: "open" | "save" | "complete" | "cancel",
    input: Record<string, unknown>,
    options: WriteOptions,
  ): HistoryCheckpoint {
    return this.db.transaction(() => {
      if (!["open", "save", "complete", "cancel"].includes(action)) {
        invalid("Неизвестное действие точки работы.");
      }
      const write = writeOptions(options);
      const values = object(input, [
        ...materialFields,
        ...(action === "open" ? [] : ["acceptedSessionIds"]),
      ]);
      const intent = action === "open" ? null : this.getCheckpoint(ref);
      const session = intent === null ? this.get(ref) : this.get(intent.data.sessionId);
      this.checkRevision(session, write.ifRevision);
      const run = this.checkOwner(session, values.runId, write.actor);
      if (intent !== null) this.checkOpenIntent(intent);
      const accepted = stringArray(values.acceptedSessionIds, "acceptedSessionIds");
      if (intent !== null) {
        this.checkAcceptance(session.id, intent.id, accepted);
        if (action === "complete" || action === "cancel") {
          this.checkChildrenClosure(session.id, intent.id, accepted);
        }
      }
      const materials = this.checkpoints().filter((entry) => entry.data.sessionId === session.id);
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
          sequence: materials.reduce((max, entry) => Math.max(max, entry.data.sequence), 0) + 1,
          sessionRevision: session.revision + 1,
          title: text(values.title, "title", true),
          body: text(values.body, "body"),
          summary: optionalText(values.summary, "summary"),
          done: optionalText(values.done, "done"),
          remaining: optionalText(values.remaining, "remaining"),
          nextStep: optionalText(values.nextStep, "nextStep"),
          checks: optionalText(values.checks, "checks"),
          references: this.references(values.references),
          acceptedSessionIds: accepted,
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
    return this.db.snapshot(() => this.subtree(this.get(ref)));
  }

  intents(ref: string, includeChildren = false): HistoryCheckpoint[] {
    return this.db.snapshot(() => {
      if (typeof includeChildren !== "boolean") invalid("includeChildren: ожидается boolean.");
      const session = this.get(ref);
      const sessionIds = new Set(
        (includeChildren ? this.subtree(session) : [session]).map((entry) => entry.id),
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

  context(ref: string): {
    session: HistorySession;
    checkpoints: HistoryCheckpoint[];
    intents: HistoryCheckpoint[];
    children: HistorySession[];
  } {
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

  private lookup(ref: string, kind: EntityKind): EntityRecord {
    const reference = text(ref, "Ссылка", true);
    const id = reference.startsWith(`${kind}:`) ? reference.slice(kind.length + 1) : reference;
    const record = this.db.get(id, kind);
    if (!record) throw new RelayError("NOT_FOUND", `Не найдена запись ${reference}.`, 3);
    return record;
  }

  private sessions(): HistorySession[] {
    return this.db.list("work-session") as HistorySession[];
  }

  private checkpoints(): HistoryCheckpoint[] {
    return this.db.list("work-checkpoint") as HistoryCheckpoint[];
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
    input: Record<string, unknown>,
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
      reason: optionalText(input.reason, "reason"),
      operator: operator(input.operator),
      client: optionalText(input.client, "client", true),
      sourceSessionId: optionalText(input.sourceSessionId, "sourceSessionId", true),
      predecessorRunId,
      startedAt: now,
      endedAt: null,
      endReason: null,
    };
  }

  private newSession(
    input: Record<string, unknown>,
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
        title: text(input.title, "title", true),
        description: optionalText(input.description, "description"),
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

  private checkRevision(session: HistorySession, expected: number): void {
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

  private checkOwner(session: HistorySession, runId: unknown, actor: string): HistoryRun {
    const id = text(runId, "runId", true);
    if (session.data.status !== "open" || session.data.currentRunId === null) {
      conflict("Владельческая запись требует открытой сессии с текущим участием.");
    }
    if (session.data.currentRunId !== id) {
      conflict("Этот run не владеет сессией. Требуется постоянный ID текущего участия.");
    }
    const run = session.data.runs.find((entry) => entry.id === id);
    if (!run || run.state !== "active" || run.actor !== actor) {
      conflict("Автор записи должен совпадать с агентом текущего активного участия.");
    }
    return run;
  }

  private endRun(
    session: HistorySession,
    state: Exclude<HistoryRun["state"], "active">,
    reason: string,
    now: string,
  ): void {
    const run = session.data.runs.find((entry) => entry.id === session.data.currentRunId);
    if (!run || run.state !== "active") conflict("У сессии отсутствует активное участие.");
    run.state = state;
    run.endedAt = now;
    run.endReason = reason;
    session.data.currentRunId = null;
  }

  private saveSession(session: HistorySession, options: WriteOptions, now: string): HistorySession {
    session.revision += 1;
    session.updatedAt = now;
    session.updatedBy = options.actor;
    this.db.update(session, options.ifRevision);
    return session;
  }

  private checkOpenIntent(intent: HistoryCheckpoint): void {
    if (intent.data.kind !== "intent") invalid("Ссылка должна указывать на исходный intent.");
    const closed = this.checkpoints().some(
      (entry) =>
        entry.data.intentId === intent.id &&
        (entry.data.kind === "result" || entry.data.kind === "cancel"),
    );
    if (closed) conflict("Намерение уже закрыто. Создайте новое намерение для дальнейшей работы.");
  }

  private fork(ref: string, input: Record<string, unknown>, options: WriteOptions): HistorySession {
    const values = object(input, ["title", "description", "runId"]);
    const intent = this.getCheckpoint(ref);
    const parent = this.get(intent.data.sessionId);
    this.checkRevision(parent, options.ifRevision);
    const run = this.checkOwner(parent, values.runId, options.actor);
    this.checkOpenIntent(intent);
    const now = new Date().toISOString();
    const child = this.newSession(values, options.actor, now, {
      parentSessionId: parent.id,
      originCheckpointId: intent.id,
      createdByRunId: run.id,
    });
    this.db.insert(child);
    this.saveSession(parent, options, now);
    return child;
  }

  private references(value: unknown): HistoryReference[] {
    const ids = new Set<string>();
    return stringArray(value, "references").map((reference) => {
      const separator = reference.indexOf(":");
      const target = this.db.get(separator < 0 ? reference : reference.slice(separator + 1));
      if (!target) throw new RelayError("NOT_FOUND", `Не найдена ссылка ${reference}.`, 3);
      if (separator >= 0 && target.kind !== reference.slice(0, separator)) {
        throw new RelayError("NOT_FOUND", `Не найдена ссылка ${reference}.`, 3);
      }
      if (ids.has(target.id)) invalid("references: одна запись указана несколько раз.");
      ids.add(target.id);
      const title = target.data.title ?? target.data.name ?? target.key;
      return {
        id: target.id,
        kind: target.kind,
        key: target.key,
        title: typeof title === "string" ? title : target.key,
      };
    });
  }

  private checkAcceptance(sessionId: string, intentId: string, accepted: string[]): void {
    for (const id of accepted) {
      const child = this.get(id);
      if (child.id !== id)
        invalid("acceptedSessionIds принимает постоянные ID, а не ключи или адреса.");
      if (child.data.parentSessionId !== sessionId || child.data.originCheckpointId !== intentId) {
        conflict("Можно принять только прямого ребёнка исходного намерения.");
      }
      if (child.data.status !== "completed") {
        conflict("Принимается только результат завершённого, не отменённого ребёнка.");
      }
    }
  }

  private checkChildrenClosure(
    sessionId: string,
    intentId: string | null,
    accepted: string[],
  ): void {
    const children = this.sessions().filter(
      (entry) =>
        entry.data.parentSessionId === sessionId &&
        (intentId === null || entry.data.originCheckpointId === intentId),
    );
    const acceptedIds = new Set(accepted);
    for (const entry of this.checkpoints()) {
      if (entry.data.sessionId !== sessionId) continue;
      if (intentId !== null && entry.data.intentId !== intentId) continue;
      for (const id of entry.data.acceptedSessionIds) acceptedIds.add(id);
    }
    for (const child of children) {
      if (unfinished(child))
        conflict("Сначала закройте дочернюю работу.", { childSessionId: child.id });
      if (child.data.status === "completed" && !acceptedIds.has(child.id)) {
        conflict("Результат дочерней работы ещё не принят родителем.", {
          childSessionId: child.id,
        });
      }
    }
  }

  private checkSessionClosure(session: HistorySession): void {
    if (this.intents(session.id).length > 0) conflict("Сначала закройте все намерения сессии.");
    this.checkChildrenClosure(session.id, null, []);
  }

  private subtree(root: HistorySession): HistorySession[] {
    const children = new Map<string, HistorySession[]>();
    for (const session of this.sessions()) {
      if (session.data.parentSessionId === null) continue;
      const siblings = children.get(session.data.parentSessionId) ?? [];
      siblings.push(session);
      children.set(session.data.parentSessionId, siblings);
    }
    const result: HistorySession[] = [];
    const visited = new Set<string>();
    const queue = [root];
    for (let position = 0; position < queue.length; position += 1) {
      const session = queue[position]!;
      if (visited.has(session.id)) conflict("Обнаружен цикл дочерних сессий.");
      visited.add(session.id);
      result.push(session);
      queue.push(...(children.get(session.id) ?? []));
    }
    return result;
  }
}
