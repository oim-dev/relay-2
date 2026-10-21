/** Декодирование сохранённой истории без обращения к БД; неизвестные формы не заменяются пустыми. */
import {
  RelayError,
  isEntityKind,
  validateActor,
  historyCheckpointKinds,
  historyOperatorSources,
  historyRunStates,
  historySessionStatuses,
  type EntityRecord,
  type HistoryCheckpoint,
  type HistoryCheckpointData,
  type HistoryOperator,
  type HistoryReference,
  type HistoryRun,
  type HistorySession,
  type HistorySessionData,
} from "@relay/contracts";

class HistoryDecoder {
  constructor(private readonly record: EntityRecord) {}

  corrupt(field: string, cause?: Error): never {
    const error = new RelayError(
      "CORRUPT_DATA",
      `Повреждена история ${this.record.key}: ${field}.`,
      1,
      {
        id: this.record.id,
        field,
      },
    );
    if (cause !== undefined) error.cause = cause;
    throw error;
  }

  object(value: unknown, field: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) this.corrupt(field);
    return value as Record<string, unknown>;
  }

  text(value: unknown, field: string, singleLine = false): string {
    if (typeof value !== "string" || !value.trim() || (singleLine && /[\r\n]/u.test(value))) {
      this.corrupt(field);
    }
    return value;
  }

  nullableText(value: unknown, field: string, singleLine = false): string | null {
    return value === null ? null : this.text(value, field, singleLine);
  }

  timestamp(value: unknown, field: string): string {
    const result = this.text(value, field, true);
    if (!Number.isFinite(Date.parse(result))) this.corrupt(field);
    return result;
  }

  actor(value: unknown, field: string): string {
    try {
      return validateActor(value);
    } catch (error) {
      if (error instanceof RelayError && error.code === "INVALID_ARGUMENT")
        this.corrupt(field, error);
      throw error;
    }
  }

  enumeration<T extends string>(value: unknown, values: readonly T[], field: string): T {
    const result = values.find((entry) => entry === value);
    if (result === undefined) this.corrupt(field);
    return result;
  }

  positiveInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) this.corrupt(field);
    return value;
  }

  array<T>(value: unknown, field: string, decode: (item: unknown, field: string) => T): T[] {
    if (!Array.isArray(value)) this.corrupt(field);
    return Array.from(value, (item, index) => decode(item, `${field}[${index}]`));
  }

  unique(values: string[], field: string): void {
    if (new Set(values).size !== values.length) this.corrupt(field);
  }

  operator(value: unknown, field: string): HistoryOperator | null {
    if (value === null) return null;
    const input = this.object(value, field);
    return {
      name: this.nullableText(input.name, `${field}.name`, true),
      email: this.nullableText(input.email, `${field}.email`, true),
      source: this.enumeration(input.source, historyOperatorSources, `${field}.source`),
    };
  }

  run(value: unknown, field: string): HistoryRun {
    const input = this.object(value, field);
    const run: HistoryRun = {
      id: this.text(input.id, `${field}.id`, true),
      key: this.text(input.key, `${field}.key`, true),
      actor: this.actor(input.actor, `${field}.actor`),
      state: this.enumeration(input.state, historyRunStates, `${field}.state`),
      reason: this.nullableText(input.reason, `${field}.reason`),
      operator: this.operator(input.operator, `${field}.operator`),
      client: this.nullableText(input.client, `${field}.client`, true),
      sourceSessionId: this.nullableText(input.sourceSessionId, `${field}.sourceSessionId`, true),
      predecessorRunId: this.nullableText(
        input.predecessorRunId,
        `${field}.predecessorRunId`,
        true,
      ),
      startedAt: this.timestamp(input.startedAt, `${field}.startedAt`),
      endedAt: input.endedAt === null ? null : this.timestamp(input.endedAt, `${field}.endedAt`),
      endReason: this.nullableText(input.endReason, `${field}.endReason`),
    };
    if (run.key !== `RUN-${run.id}`) this.corrupt(`${field}.key`);
    if (
      run.state === "active"
        ? run.endedAt !== null || run.endReason !== null
        : run.endedAt === null || run.endReason === null
    ) {
      this.corrupt(`${field}.state/endedAt/endReason`);
    }
    return run;
  }

  reference(value: unknown, field: string): HistoryReference {
    const input = this.object(value, field);
    if (!isEntityKind(input.kind)) this.corrupt(`${field}.kind`);
    if (typeof input.title !== "string") this.corrupt(`${field}.title`);
    return {
      id: this.text(input.id, `${field}.id`, true),
      kind: input.kind,
      key: this.text(input.key, `${field}.key`, true),
      title: input.title,
    };
  }

  sessionData(): HistorySessionData {
    const input = this.object(this.record.data, "data");
    const data: HistorySessionData = {
      title: this.text(input.title, "title", true),
      description: this.nullableText(input.description, "description"),
      status: this.enumeration(input.status, historySessionStatuses, "status"),
      currentRunId: this.nullableText(input.currentRunId, "currentRunId", true),
      runs: this.array(input.runs, "runs", (value, field) => this.run(value, field)),
      parentSessionId: this.nullableText(input.parentSessionId, "parentSessionId", true),
      originCheckpointId: this.nullableText(input.originCheckpointId, "originCheckpointId", true),
      createdByRunId: this.nullableText(input.createdByRunId, "createdByRunId", true),
      result: this.nullableText(input.result, "result"),
      closedAt: input.closedAt === null ? null : this.timestamp(input.closedAt, "closedAt"),
    };
    this.checkSession(data);
    return data;
  }

  private checkSession(data: HistorySessionData): void {
    this.unique(
      data.runs.map((run) => run.id),
      "runs.id",
    );
    for (const [index, run] of data.runs.entries()) {
      if (run.predecessorRunId !== (data.runs[index - 1]?.id ?? null))
        this.corrupt("runs.predecessorRunId");
      if (index < data.runs.length - 1 && run.state !== "paused" && run.state !== "transferred") {
        this.corrupt("runs.state");
      }
    }
    const last = data.runs.at(-1);
    if (data.status === "open") {
      if (!last || last.state !== "active" || data.currentRunId !== last.id)
        this.corrupt("currentRunId/runs");
    } else if (data.currentRunId !== null || data.runs.some((run) => run.state === "active")) {
      this.corrupt("currentRunId/runs");
    }
    if (data.status === "pending" && (last || data.parentSessionId === null))
      this.corrupt("status/runs");
    if (data.status === "paused" && last?.state !== "paused") this.corrupt("status/runs");
    if (data.status === "completed" && last?.state !== "completed") this.corrupt("status/runs");
    if (
      data.status === "cancelled" &&
      last &&
      last.state !== "paused" &&
      last.state !== "cancelled"
    ) {
      this.corrupt("status/runs");
    }
    const closed = data.status === "completed" || data.status === "cancelled";
    if (
      closed
        ? data.closedAt === null || data.result === null
        : data.closedAt !== null || data.result !== null
    ) {
      this.corrupt("status/closedAt/result");
    }
    const origin = [data.parentSessionId, data.originCheckpointId, data.createdByRunId];
    if (origin.some((value) => value === null) && origin.some((value) => value !== null)) {
      this.corrupt("parentSessionId/originCheckpointId/createdByRunId");
    }
  }

  checkpointData(): HistoryCheckpointData {
    const input = this.object(this.record.data, "data");
    const data: HistoryCheckpointData = {
      kind: this.enumeration(input.kind, historyCheckpointKinds, "kind"),
      sessionId: this.text(input.sessionId, "sessionId", true),
      runId: this.text(input.runId, "runId", true),
      actor: this.actor(input.actor, "actor"),
      intentId: this.nullableText(input.intentId, "intentId", true),
      sequence: this.positiveInteger(input.sequence, "sequence"),
      sessionRevision: this.positiveInteger(input.sessionRevision, "sessionRevision"),
      title: this.text(input.title, "title", true),
      body: this.text(input.body, "body"),
      summary: this.nullableText(input.summary, "summary"),
      done: this.nullableText(input.done, "done"),
      remaining: this.nullableText(input.remaining, "remaining"),
      nextStep: this.nullableText(input.nextStep, "nextStep"),
      checks: this.nullableText(input.checks, "checks"),
      references: this.array(input.references, "references", (value, field) =>
        this.reference(value, field),
      ),
      acceptedSessionIds: this.array(
        input.acceptedSessionIds,
        "acceptedSessionIds",
        (value, field) => this.text(value, field, true),
      ),
    };
    this.unique(
      data.references.map((reference) => reference.id),
      "references.id",
    );
    this.unique(data.acceptedSessionIds, "acceptedSessionIds");
    if ((data.kind === "intent") !== (data.intentId === null)) this.corrupt("kind/intentId");
    if (data.kind === "intent" && data.acceptedSessionIds.length > 0)
      this.corrupt("acceptedSessionIds");
    if (data.sessionRevision < 2 || this.record.revision !== 1)
      this.corrupt("revision/sessionRevision");
    if (data.actor !== this.record.createdBy || data.actor !== this.record.updatedBy)
      this.corrupt("actor");
    return data;
  }

  metadata(): void {
    this.actor(this.record.createdBy, "createdBy");
    this.actor(this.record.updatedBy, "updatedBy");
  }
}

export function decodeHistorySession(record: EntityRecord): HistorySession {
  const decoder = new HistoryDecoder(record);
  if (record.kind !== "work-session") decoder.corrupt("kind");
  decoder.metadata();
  return { ...record, kind: "work-session", data: decoder.sessionData() };
}

export function decodeHistoryCheckpoint(record: EntityRecord): HistoryCheckpoint {
  const decoder = new HistoryDecoder(record);
  if (record.kind !== "work-checkpoint") decoder.corrupt("kind");
  decoder.metadata();
  return { ...record, kind: "work-checkpoint", data: decoder.checkpointData() };
}
