/**
 * Декодирование сохранённой истории без обращения к БД; неизвестные формы не заменяются пустыми.
 */
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
import type { HistoryTextOptions } from "./history-input.types";
import { historyDataMessages } from "./history-messages";
import { HISTORY_TITLE_RULES, historyTextViolation } from "./history-text";

/**
 * Проверяет форму записи и внутреннюю согласованность участия, не разрешая ссылки в БД.
 */
class HistoryDecoder {
  /* Исходная запись для декодирования и адресной диагностики; не изменяется. */
  private readonly record: Readonly<EntityRecord>;

  /**
   * Привязывает диагностику к исходной записи, не меняя её содержание.
   */
  constructor(record: Readonly<EntityRecord>) {
    this.record = record;
  }

  /**
   * Отклоняет повреждение с ID и путём поля, сохраняя исходную причину ошибки при её наличии.
   */
  corrupt(field: string, cause?: Error): never {
    const error = new RelayError(
      "CORRUPT_DATA",
      historyDataMessages.corruptField(this.record.key, field),
      1,
      {
        id: this.record.id,
        field,
      },
    );
    if (cause !== undefined) {
      error.cause = cause;
    }
    throw error;
  }

  /**
   * Проверяет объект на границе хранения; значения его полей требуют дальнейшего декодирования.
   */
  object(value: unknown, field: string): Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.corrupt(field);
    }
    // Проверена объектная форма; утверждение типа не объявляет значения полей валидными.
    return value as Readonly<Record<string, unknown>>;
  }

  /**
   * Проверяет непустой текст и формат строки без нормализации сохранённого содержания.
   */
  text(value: unknown, field: string, options: HistoryTextOptions = {}): string {
    if (typeof value !== "string" || historyTextViolation(value, options) !== undefined) {
      this.corrupt(field);
    }
    return value;
  }

  /**
   * Допускает явный null, но считает отсутствующее обязательное nullable-поле повреждением.
   */
  nullableText(value: unknown, field: string, options: HistoryTextOptions = {}): string | null {
    return value === null ? null : this.text(value, field, options);
  }

  /**
   * Проверяет сохранённую дату, не меняя исходное строковое представление.
   */
  timestamp(value: unknown, field: string): string {
    const result = this.text(value, field, { singleLine: true });
    if (!Number.isFinite(Date.parse(result))) {
      this.corrupt(field);
    }
    return result;
  }

  /**
   * Применяет общее правило автора, преобразуя только ожидаемый отказ в повреждение хранения.
   */
  actor(value: unknown, field: string): string {
    try {
      return validateActor(value);
    } catch (error) {
      if (error instanceof RelayError && error.code === "INVALID_ARGUMENT") {
        this.corrupt(field, error);
      }
      throw error;
    }
  }

  /**
   * Возвращает значение предметного перечисления либо отклоняет неизвестную форму.
   */
  enumeration<T extends string>(value: unknown, values: readonly T[], field: string): T {
    const result = values.find((entry) => entry === value);
    if (result === undefined) {
      this.corrupt(field);
    }
    return result;
  }

  /**
   * Проверяет положительное безопасное целое для порядка материала и ревизии сессии.
   */
  positiveInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      this.corrupt(field);
    }
    return value;
  }

  /**
   * Декодирует каждый элемент массива, включая пропуски; неверная форма не становится пустым списком.
   */
  array<T>(value: unknown, field: string, decode: (item: unknown, field: string) => T): T[] {
    if (!Array.isArray(value)) {
      this.corrupt(field);
    }
    return Array.from(value, (item, index) => decode(item, `${field}[${index}]`));
  }

  /**
   * Отклоняет повторяющиеся постоянные ID внутри одной сохранённой коллекции.
   */
  unique(values: readonly string[], field: string): void {
    if (new Set(values).size !== values.length) {
      this.corrupt(field);
    }
  }

  /**
   * Декодирует пользователя участия; отсутствие пользователя представлено только явным null.
   */
  operator(value: unknown, field: string): HistoryOperator | null {
    if (value === null) {
      return null;
    }
    const input = this.object(value, field);
    return {
      name: this.nullableText(input.name, `${field}.name`, { singleLine: true }),
      email: this.nullableText(input.email, `${field}.email`, { singleLine: true }),
      source: this.enumeration(input.source, historyOperatorSources, `${field}.source`),
    };
  }

  /**
   * Декодирует участие и проверяет согласованность его ключа, состояния и завершения.
   */
  run(value: unknown, field: string): HistoryRun {
    const input = this.object(value, field);
    const run: HistoryRun = {
      id: this.text(input.id, `${field}.id`, { singleLine: true }),
      key: this.text(input.key, `${field}.key`, { singleLine: true }),
      actor: this.actor(input.actor, `${field}.actor`),
      state: this.enumeration(input.state, historyRunStates, `${field}.state`),
      reason: this.nullableText(input.reason, `${field}.reason`),
      operator: this.operator(input.operator, `${field}.operator`),
      client: this.nullableText(input.client, `${field}.client`, { singleLine: true }),
      sourceSessionId: this.nullableText(input.sourceSessionId, `${field}.sourceSessionId`, {
        singleLine: true,
      }),
      predecessorRunId: this.nullableText(input.predecessorRunId, `${field}.predecessorRunId`, {
        singleLine: true,
      }),
      startedAt: this.timestamp(input.startedAt, `${field}.startedAt`),
      endedAt: input.endedAt === null ? null : this.timestamp(input.endedAt, `${field}.endedAt`),
      endReason: this.nullableText(input.endReason, `${field}.endReason`),
    };
    if (run.key !== `RUN-${run.id}`) {
      this.corrupt(`${field}.key`);
    }
    if (
      run.state === "active"
        ? run.endedAt !== null || run.endReason !== null
        : run.endedAt === null || run.endReason === null
    ) {
      this.corrupt(`${field}.state/endedAt/endReason`);
    }
    return run;
  }

  /**
   * Декодирует снимок ссылки; пустой заголовок допустим для предметных записей без названия.
   */
  reference(value: unknown, field: string): HistoryReference {
    const input = this.object(value, field);
    if (!isEntityKind(input.kind)) {
      this.corrupt(`${field}.kind`);
    }
    if (typeof input.title !== "string") {
      this.corrupt(`${field}.title`);
    }
    return {
      id: this.text(input.id, `${field}.id`, { singleLine: true }),
      kind: input.kind,
      key: this.text(input.key, `${field}.key`, { singleLine: true }),
      title: input.title,
    };
  }

  /**
   * Декодирует сессию и проверяет согласованность цепочки участия, статуса и происхождения.
   */
  sessionData(): HistorySessionData {
    const input = this.object(this.record.data, "data");
    const data: HistorySessionData = {
      title: this.text(input.title, "title", HISTORY_TITLE_RULES),
      description: this.nullableText(input.description, "description"),
      status: this.enumeration(input.status, historySessionStatuses, "status"),
      currentRunId: this.nullableText(input.currentRunId, "currentRunId", { singleLine: true }),
      runs: this.array(input.runs, "runs", (value, field) => this.run(value, field)),
      parentSessionId: this.nullableText(input.parentSessionId, "parentSessionId", {
        singleLine: true,
      }),
      originCheckpointId: this.nullableText(input.originCheckpointId, "originCheckpointId", {
        singleLine: true,
      }),
      createdByRunId: this.nullableText(input.createdByRunId, "createdByRunId", {
        singleLine: true,
      }),
      result: this.nullableText(input.result, "result"),
      closedAt: input.closedAt === null ? null : this.timestamp(input.closedAt, "closedAt"),
    };
    this.checkSessionRuns(data);
    this.checkSessionClosure(data);
    return data;
  }

  /**
   * Проверяет единственную последовательную цепочку участия и соответствие последнего run статусу.
   */
  private checkSessionRuns(data: Readonly<HistorySessionData>): void {
    this.unique(
      data.runs.map((run) => run.id),
      "runs.id",
    );
    for (const [index, run] of data.runs.entries()) {
      if (run.predecessorRunId !== (data.runs[index - 1]?.id ?? null)) {
        this.corrupt("runs.predecessorRunId");
      }
      if (index < data.runs.length - 1 && run.state !== "paused" && run.state !== "transferred") {
        this.corrupt("runs.state");
      }
    }
    const last = data.runs.at(-1);
    if (data.status === "open") {
      if (!last || last.state !== "active" || data.currentRunId !== last.id) {
        this.corrupt("currentRunId/runs");
      }
    } else if (data.currentRunId !== null || data.runs.some((run) => run.state === "active")) {
      this.corrupt("currentRunId/runs");
    }
    if (data.status === "pending" && (last || data.parentSessionId === null)) {
      this.corrupt("status/runs");
    }
    if (data.status === "paused" && last?.state !== "paused") {
      this.corrupt("status/runs");
    }
    if (data.status === "completed" && last?.state !== "completed") {
      this.corrupt("status/runs");
    }
    if (
      data.status === "cancelled" &&
      last &&
      last.state !== "paused" &&
      last.state !== "cancelled"
    ) {
      this.corrupt("status/runs");
    }
  }

  /**
   * Проверяет обязательность итога закрытия и неделимость тройки происхождения ребёнка.
   */
  private checkSessionClosure(data: Readonly<HistorySessionData>): void {
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

  /**
   * Декодирует append-only материал, проверяя авторство, ссылку intent и ревизию владельца.
   */
  checkpointData(): HistoryCheckpointData {
    const input = this.object(this.record.data, "data");
    const data: HistoryCheckpointData = {
      kind: this.enumeration(input.kind, historyCheckpointKinds, "kind"),
      sessionId: this.text(input.sessionId, "sessionId", { singleLine: true }),
      runId: this.text(input.runId, "runId", { singleLine: true }),
      actor: this.actor(input.actor, "actor"),
      intentId: this.nullableText(input.intentId, "intentId", { singleLine: true }),
      sequence: this.positiveInteger(input.sequence, "sequence"),
      sessionRevision: this.positiveInteger(input.sessionRevision, "sessionRevision"),
      title: this.text(input.title, "title", HISTORY_TITLE_RULES),
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
        (value, field) => this.text(value, field, { singleLine: true }),
      ),
    };
    this.unique(
      data.references.map((reference) => reference.id),
      "references.id",
    );
    this.unique(data.acceptedSessionIds, "acceptedSessionIds");
    if ((data.kind === "intent") !== (data.intentId === null)) {
      this.corrupt("kind/intentId");
    }
    if (data.kind === "intent" && data.acceptedSessionIds.length > 0) {
      this.corrupt("acceptedSessionIds");
    }
    if (data.sessionRevision < 2 || this.record.revision !== 1) {
      this.corrupt("revision/sessionRevision");
    }
    if (data.actor !== this.record.createdBy || data.actor !== this.record.updatedBy) {
      this.corrupt("actor");
    }
    return data;
  }

  /**
   * Проверяет авторов метаданных записи общим правилом автора истории.
   */
  metadata(): void {
    this.actor(this.record.createdBy, "createdBy");
    this.actor(this.record.updatedBy, "updatedBy");
  }
}

/**
 * Возвращает отдельный проверенный объект сессии; неверный вид или данные дают CORRUPT_DATA.
 * Декодирование не обращается к БД и не изменяет исходную запись.
 */
export function decodeHistorySession(record: Readonly<EntityRecord>): HistorySession {
  const decoder = new HistoryDecoder(record);
  if (record.kind !== "work-session") {
    decoder.corrupt("kind");
  }
  decoder.metadata();
  return { ...record, kind: "work-session", data: decoder.sessionData() };
}

/**
 * Возвращает отдельный проверенный материал; повреждение не превращается в пустые поля.
 * Проверяется неизменяемая ревизия материала, но не существование его внешних ссылок.
 */
export function decodeHistoryCheckpoint(record: Readonly<EntityRecord>): HistoryCheckpoint {
  const decoder = new HistoryDecoder(record);
  if (record.kind !== "work-checkpoint") {
    decoder.corrupt("kind");
  }
  decoder.metadata();
  return { ...record, kind: "work-checkpoint", data: decoder.checkpointData() };
}
