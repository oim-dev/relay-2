import { join } from "node:path";
import { RelayError, type GitSyncControlOutcome } from "@relay/contracts";
import { appMessages } from "../app/app.messages";
import { responseData } from "../app/errors";
import { controlRequest, readEndpoint } from "./control";
import { decodeOutcome, operationId, readOperation } from "./operations";
import { waitUntil } from "./deadline";
import type { ControlEndpoint } from "./control.types";

/**
 * Возвращает только достоверный live/retained результат. Недоступный owner даёт unknown для активной записи.
 */
export async function getOperation(
  directory: string,
  id: string,
  endpoint?: ControlEndpoint,
): Promise<GitSyncControlOutcome> {
  operationId(id);
  const owner = endpoint ?? readEndpoint(join(directory, "worker.json"));
  if (
    owner &&
    (owner.identity !== directory.slice(0, -".git-sync".length) || owner.kind === "supervisor")
  ) {
    throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
  }
  if (owner) {
    const response = await controlRequest(owner, "operation.get", { requestId: id });
    if (response?.ok) {
      return decodeOutcome(response.data);
    }
  }
  return readOperation(directory, id);
}

/**
 * Передаёт один submit и возвращает ID. Не повторяет запрос после неясного сетевого отказа.
 */
export async function submitOperation(
  endpoint: ControlEndpoint,
  id: string,
  action: "now" | "status",
): Promise<void> {
  const response = await controlRequest(
    endpoint,
    "operation.submit",
    { action },
    5000,
    operationId(id),
  );
  if (response === null) {
    throw new RelayError("GIT_SYNC_OUTCOME_UNKNOWN", appMessages.outcomeUnknown, 4, {
      requestId: id,
      instance: endpoint.instance,
      state: "unknown",
    });
  }
  decodeOutcome(responseData(response));
}

/**
 * Deadline ожидания не отменяет persistent operation и не объявляет живой процесс неготовым.
 * Повтор/query с requestId читает исход, никогда не создаёт новую network operation.
 */
export async function waitOperation(
  directory: string,
  id: string,
  timeoutMs = 60_000,
  endpoint?: ControlEndpoint,
): Promise<unknown> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let outcome: GitSyncControlOutcome;
    try {
      outcome = await getOperation(directory, id, endpoint);
    } catch (error) {
      if (error instanceof RelayError) {
        throw new RelayError(error.code, error.message, error.exitCode, {
          ...error.details,
          requestId: id,
          instance: endpoint?.instance ?? null,
          state: "unknown",
        });
      }
      throw error;
    }
    if (outcome.state === "completed") {
      return {
        ...(outcome.result && typeof outcome.result === "object" && !Array.isArray(outcome.result)
          ? outcome.result
          : { result: outcome.result }),
        requestId: id,
      };
    }
    if (outcome.state === "failed") {
      throw new RelayError(outcome.error.code, outcome.error.message, outcome.error.exitCode, {
        ...outcome.error.details,
        requestId: id,
        instance: outcome.instance,
        state: "failed",
      });
    }
    if (outcome.state === "unknown") {
      throw new RelayError("GIT_SYNC_OUTCOME_UNKNOWN", appMessages.outcomeUnknown, 4, {
        requestId: id,
        instance: outcome.instance,
        state: "unknown",
      });
    }
    if (Date.now() >= deadline) {
      throw new RelayError("GIT_SYNC_WAIT_TIMEOUT", appMessages.waitTimeout, 4, {
        requestId: id,
        instance: outcome.instance,
        state: outcome.state,
        query: ["relay", "git-sync", "request", "get", id],
      });
    }
    await waitUntil(Math.min(deadline, Date.now() + 100), AbortSignal.timeout(1000));
  }
}

/**
 * Ограничивает время ожидания до принятия операции, включая неверный тип JSON.
 */
export function operationWait(value: unknown): number {
  if (value === undefined) {
    return 60_000;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 90_000) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  return value;
}
