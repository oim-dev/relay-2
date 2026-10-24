import { randomUUID } from "node:crypto";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import { assertGitSyncJson } from "./request";
import { gitSyncMessages as messages } from "./git-sync.messages";
import type {
  CorrelatedGitSyncRequest,
  GitSyncRequestCorrelation,
} from "./request-correlation.types";

/**
 * Требует непустой строковый ID, сохраняя его дословно; полный wire-формат проверяет компонент.
 */
function correlationId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RelayError("INVALID_ARGUMENT", messages.requestIdRequired, 2, { field });
  }
  return value;
}

/**
 * Назначает correlation до version probe/spawn, сохраняя envelope v1 и исходный input.
 * requestId означает только ожидание/чтение прежнего исхода и запрещает создание operationId.
 */
export function correlateGitSyncRequest(request: GitSyncRequest): CorrelatedGitSyncRequest {
  assertGitSyncJson(request);
  if (
    request.input !== undefined &&
    (typeof request.input !== "object" || request.input === null || Array.isArray(request.input))
  ) {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", messages.invalidRequestJson, 2);
  }
  const input = request.input ?? {};
  const network =
    request.action === "now" || (request.action === "status" && input.refresh === true);
  if (request.action === "request.get") {
    return {
      request,
      correlation: { requestId: correlationId(input.requestId, "input.requestId"), mode: "read" },
    };
  }
  if (!network) {
    return { request };
  }
  if (input.requestId !== undefined) {
    if (input.operationId !== undefined) {
      throw new RelayError("INVALID_ARGUMENT", messages.conflictingRequestIds, 2);
    }
    return {
      request,
      correlation: { requestId: correlationId(input.requestId, "input.requestId"), mode: "wait" },
    };
  }
  const requestId =
    input.operationId === undefined
      ? randomUUID()
      : correlationId(input.operationId, "input.operationId");
  return {
    request: { ...request, input: { ...input, operationId: requestId } },
    correlation: { requestId, mode: "submit" },
  };
}

/**
 * Сохраняет ID при инфраструктурном отказе, не объявляя запрос принятым, отменённым или завершённым.
 * Код/exit/cause и native details сохранены; ошибки самого компонента обрабатываются отдельно.
 */
export function correlatedTransportFailure(
  cause: unknown,
  correlation?: GitSyncRequestCorrelation,
): unknown {
  if (!(cause instanceof RelayError) || correlation === undefined) {
    return cause;
  }
  const message =
    cause.code === "GIT_SYNC_CANCELLED" ? messages.requestWaitCancelled : cause.message;
  const failure = new RelayError(cause.code, message, cause.exitCode, {
    ...cause.details,
    requestId: correlation.requestId,
    ...(correlation.mode === "submit" ? { operationId: correlation.requestId } : {}),
    state: "unknown",
  });
  failure.cause = cause;
  return failure;
}
