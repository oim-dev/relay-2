import { decodeGitSyncRequest, RelayError, type GitSyncRequest } from "@relay/contracts";
import {
  correlateGitSyncRequest,
  correlatedTransportFailure,
  encodeGitSyncRequest,
} from "@relay/project-runtime";
import { executeAction } from "../app/actions";
import { withGitProcessRuntime } from "../transport/process-runtime";
import { withGitExecution } from "./context";
import type { GitSyncExecutionOptions } from "./execution.types";
import { executionMessages as messages } from "./execution.messages";
import { executionFailure, hasSignificantGitFailure } from "./failure";

const AUTOMATIC_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Выполняет одно обращение CLI напрямую, без дополнительного приложения или постоянного процесса.
 * Snapshot JSON сохраняет прежнюю wire-семантику и назначает operationId до I/O; callback не повторяется.
 * Среда и signal изолированы; source helper создаётся лениво, его cleanup принадлежит обращению.
 * Отмена не откатывает уже завершённые эффекты; последующие записи останавливаются на границах await.
 * После abort ожидается cleanup, даже за пределами budget; неподтверждённое освобождение сохраняется ошибкой.
 */
export async function executeGitSyncRequest(
  request: GitSyncRequest,
  options: GitSyncExecutionOptions,
): Promise<unknown> {
  const prepared = correlateGitSyncRequest(request);
  const input = decodeGitSyncRequest(JSON.parse(encodeGitSyncRequest(prepared.request)));
  const budget = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 2_147_483_647) {
    throw new RelayError("INVALID_ARGUMENT", messages.budget, 2);
  }
  const deadline = new AbortController();
  const caller = options.signal;
  const timer = setTimeout(
    () => deadline.abort(),
    input.action === "auto" ? Math.min(budget, AUTOMATIC_TIMEOUT_MS) : budget,
  );
  const signal =
    caller === undefined ? deadline.signal : AbortSignal.any([caller, deadline.signal]);
  try {
    signal.throwIfAborted();
    const result = await withGitExecution({ env: options.env, signal }, () =>
      withGitProcessRuntime(() => executeAction(input)),
    );
    signal.throwIfAborted();
    return result;
  } catch (cause) {
    const failure = executionFailure(cause, signal, deadline.signal);
    const missingCorrelation =
      prepared.correlation !== undefined &&
      failure instanceof RelayError &&
      failure.details?.requestId === undefined &&
      hasSignificantGitFailure(failure);
    if (failure !== cause || missingCorrelation) {
      throw correlatedTransportFailure(failure, prepared.correlation);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
