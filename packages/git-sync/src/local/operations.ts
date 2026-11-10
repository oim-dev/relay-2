import { join } from "node:path";
import {
  RelayError,
  type GitSyncControlOutcome,
  type GitSyncOperationIdentity,
} from "@relay/contracts";
import { readLocalJson, writeLocalJson } from "./files";
import { appMessages } from "../app/app.messages";
import { failure } from "../app/errors";
import { requestObject, requiredString } from "../app/protocol";
import type { ActiveOperation, NetworkOperation, StoredOperation } from "./operations.types";

const RETENTION_MS = 15 * 60_000;
const MAX_RECENT = 128;
const MAX_ACTIVE = 64;

/**
 * Проверяет correlation ID до работы с журналом; имя никогда не используется как путь файла.
 */
export function operationId(value: unknown): string {
  const id = requiredString(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id)) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  return id;
}

/**
 * Проверяет сохранённый outcome на общей wire границе.
 */
export function decodeOutcome(value: unknown): GitSyncControlOutcome {
  const item = requestObject(value);
  const requestId = operationId(item.requestId);
  if (
    item.version !== 1 ||
    !["unknown", "queued", "running", "completed", "failed"].includes(String(item.state))
  ) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  if (item.state === "unknown") {
    return {
      version: 1,
      requestId,
      state: "unknown",
      instance: item.instance === null ? null : requiredString(item.instance),
    };
  }
  if (item.action !== "now" && item.action !== "status") {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  const identity: GitSyncOperationIdentity = {
    version: 1 as const,
    requestId,
    instance: requiredString(item.instance),
    action: item.action,
    acceptedAt: requiredString(item.acceptedAt),
    startedAt: item.startedAt === null ? null : requiredString(item.startedAt),
  };
  if (item.state === "queued" || item.state === "running") {
    return { ...identity, state: item.state };
  }
  const completedAt = requiredString(item.completedAt);
  if (item.state === "completed") {
    return { ...identity, state: "completed", completedAt, result: item.result };
  }
  const error = requestObject(item.error);
  if (
    typeof error.exitCode !== "number" ||
    !Number.isInteger(error.exitCode) ||
    error.exitCode < 1 ||
    error.exitCode > 255
  ) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  return {
    ...identity,
    state: "failed",
    completedAt,
    error: {
      code: requiredString(error.code),
      message: requiredString(error.message),
      exitCode: error.exitCode,
      ...(error.details === undefined ? {} : { details: requestObject(error.details) }),
    },
  };
}

/**
 * Читает только bounded recent DTO; expired и активные записи погибшего owner не становятся success/cancelled.
 */
export function readOperation(directory: string, requestId: string): GitSyncControlOutcome {
  const entries = loadOperations(directory);
  const entry = entries.get(operationId(requestId));
  if (!entry || entry.expires <= Date.now()) {
    return { version: 1, requestId, instance: null, state: "unknown" };
  }
  if (entry.outcome.state === "queued" || entry.outcome.state === "running") {
    return { version: 1, requestId, instance: entry.outcome.instance, state: "unknown" };
  }
  return entry.outcome;
}

/**
 * Декодирует собственный журнал; он не является бесконечным аудитом poll/history.
 */
function loadOperations(directory: string): Map<string, StoredOperation> {
  const value = readLocalJson(join(directory, "control-outcomes.json"));
  const result = new Map<string, StoredOperation>();
  if (value === undefined) {
    return result;
  }
  const envelope = requestObject(value);
  if (
    envelope.version !== 1 ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > MAX_ACTIVE + MAX_RECENT
  ) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  for (const value of envelope.items) {
    const record = requestObject(value);
    if (typeof record.expires !== "number" || !Number.isFinite(record.expires)) {
      throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
    }
    const outcome = decodeOutcome(record.outcome);
    if (record.expires > Date.now()) {
      result.set(outcome.requestId, { outcome, expires: record.expires });
    }
  }
  return result;
}

/**
 * Outcome registry одного живого owner. Только явные now/refresh создают записи; auto poll не журналируется.
 */
export class ControlOperations {
  /* Физический каталог проекта. */
  private readonly directory: string;
  /* Nonce owner, которым действительно принят запрос. */
  private readonly instance: string;
  /* Активные callback, ещё не завершившие свой cycle. */
  private readonly active = new Map<string, ActiveOperation>();
  /* Ограниченные recent/active результаты. */
  private readonly entries: Map<string, StoredOperation>;
  /* После начала shutdown новые операции не принимаются. */
  private closing = false;

  /**
   * Новый owner наследует только terminal results; незавершённые прежние запросы остаются unknown.
   */
  constructor(directory: string, instance: string) {
    this.directory = directory;
    this.instance = instance;
    this.entries = loadOperations(directory);
    for (const [id, entry] of this.entries) {
      if (entry.outcome.state === "queued" || entry.outcome.state === "running") {
        this.entries.set(id, {
          expires: entry.expires,
          outcome: {
            version: 1,
            requestId: id,
            instance: entry.outcome.instance,
            state: "unknown",
          },
        });
      }
    }
  }

  /**
   * Принятие идемпотентно по requestId в bounded window; пользовательская мутация здесь не повторяется.
   */
  submit(
    id: string,
    action: "now" | "status",
    signature: string,
    execute: NetworkOperation,
  ): GitSyncControlOutcome {
    operationId(id);
    const live = this.active.get(id);
    if (live && live.signature !== signature) {
      throw new RelayError("GIT_SYNC_REQUEST_ID_CONFLICT", appMessages.controlChanged, 4);
    }
    if (live) {
      return this.get(id);
    }
    const previous = this.entries.get(id);
    if (previous && previous.outcome.state !== "unknown" && previous.outcome.action !== action) {
      throw new RelayError("GIT_SYNC_REQUEST_ID_CONFLICT", appMessages.controlChanged, 4);
    }
    if (previous && previous.expires > Date.now()) {
      return this.get(id);
    }
    if (this.closing) {
      throw new RelayError("GIT_SYNC_OWNER_CLOSING", appMessages.busy, 4);
    }
    if (this.active.size >= MAX_ACTIVE) {
      throw new RelayError("GIT_SYNC_CONTROL_BUSY", appMessages.busy, 4);
    }
    const acceptedAt = new Date().toISOString();
    const identity = {
      version: 1 as const,
      requestId: id,
      instance: this.instance,
      action,
      acceptedAt,
      startedAt: null,
    };
    this.put({ ...identity, state: "queued" });
    const completion = Promise.resolve()
      .then(async () => {
        const result = await execute(() =>
          this.put({ ...identity, startedAt: new Date().toISOString(), state: "running" }),
        );
        const startedAt =
          this.get(id).state === "running" ? this.entries.get(id)?.outcome : undefined;
        this.put({
          ...identity,
          startedAt: startedAt && startedAt.state !== "unknown" ? startedAt.startedAt : acceptedAt,
          state: "completed",
          completedAt: new Date().toISOString(),
          result,
        });
      })
      .catch((cause) => {
        const error = failure(cause).error;
        const compact =
          JSON.stringify(error).length > 65_536
            ? {
                code: error.code,
                message: error.message.slice(0, 8192),
                exitCode: error.exitCode,
                details: { truncated: true },
              }
            : error;
        const current = this.entries.get(id)?.outcome;
        this.put({
          ...identity,
          startedAt: current && current.state !== "unknown" ? current.startedAt : null,
          state: "failed",
          completedAt: new Date().toISOString(),
          error: compact,
        });
      })
      .finally(() => {
        this.active.delete(id);
      });
    this.active.set(id, { signature, completion });
    void completion.catch(() => {});
    return this.get(id);
  }

  /**
   * Возвращает живую очередь только своего instance; expired/чужой незавершённый owner — unknown.
   */
  get(id: string): GitSyncControlOutcome {
    const item = this.entries.get(operationId(id));
    if (!item || (item.expires <= Date.now() && !this.active.has(id))) {
      return { version: 1, requestId: id, instance: null, state: "unknown" };
    }
    if (
      (item.outcome.state === "queued" || item.outcome.state === "running") &&
      item.outcome.instance !== this.instance
    ) {
      return { version: 1, requestId: id, instance: item.outcome.instance, state: "unknown" };
    }
    return item.outcome;
  }

  /**
   * Публикует состояние атомарно и удаляет старый terminal хвост, сохраняя все active IDs.
   */
  private put(outcome: GitSyncControlOutcome): void {
    if (outcome.state === "completed" && JSON.stringify(outcome).length > 131_072) {
      outcome = {
        version: 1,
        requestId: outcome.requestId,
        instance: outcome.instance,
        action: outcome.action,
        acceptedAt: outcome.acceptedAt,
        startedAt: outcome.startedAt,
        completedAt: outcome.completedAt,
        state: "failed",
        error: {
          code: "GIT_SYNC_OUTPUT_LIMIT",
          message: appMessages.responseLimit,
          exitCode: 1,
          details: { operationCompleted: true },
        },
      };
    }
    this.entries.delete(outcome.requestId);
    this.entries.set(outcome.requestId, { outcome, expires: Date.now() + RETENTION_MS });
    const terminal = [...this.entries].filter(
      ([, entry]) => entry.outcome.state !== "queued" && entry.outcome.state !== "running",
    );
    for (const [id] of terminal.slice(0, Math.max(0, terminal.length - MAX_RECENT))) {
      this.entries.delete(id);
    }
    for (const [id, entry] of this.entries) {
      if (entry.expires <= Date.now() && !this.active.has(id)) {
        this.entries.delete(id);
      }
    }
    writeLocalJson(join(this.directory, "control-outcomes.json"), {
      version: 1,
      items: [...this.entries.values()],
    });
  }

  /**
   * Shutdown ждёт сохранения terminal outcomes отменённых queued/running cycles.
   */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((entry) => entry.completion));
  }

  /**
   * Уже принятые IDs завершаются; поздние новые submit должны выбрать следующего owner.
   */
  closeAcceptance(): void {
    this.closing = true;
  }
}
