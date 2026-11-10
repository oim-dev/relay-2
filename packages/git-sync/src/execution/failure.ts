import { RelayError } from "@relay/contracts";
import { executionMessages as messages } from "./execution.messages";

const SIGNIFICANT_FAILURE_CODES = new Set([
  "GIT_PUSH_OUTCOME_UNKNOWN",
  "GIT_CLEANUP_FAILED",
  "GIT_GUARDIAN_FAILED",
  "GIT_GUARDIAN_PROTOCOL",
  "RESTORE_RECOVERY_REQUIRED",
]);

/**
 * Находит значимый отказ в полной cause/AggregateError цепочке, не изменяя исходные ошибки.
 * combineProcessFailures сохраняет код primary, поэтому проверка только верхнего кода скрыла бы cleanup.
 * Raw ошибки ФС должны получить предметный код у владельца cleanup; errno и тексты здесь не угадываются.
 * Циклическая цепочка cause безопасна, каждое Error посещается не более одного раза.
 */
export function hasSignificantGitFailure(cause: unknown): boolean {
  const pending = [cause];
  const visited = new Set<Error>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current instanceof RelayError && SIGNIFICANT_FAILURE_CODES.has(current.code)) {
      return true;
    }
    pending.push(current.cause);
    if (current instanceof AggregateError) {
      for (const error of current.errors) {
        pending.push(error);
      }
    }
  }
  return false;
}

/**
 * Представляет отмену всего обращения, сохраняя первую причину объединённого сигнала и исходный cause.
 * Значимый отказ, включая вторичную cleanup-причину и незавершённую публикацию restore, сохраняется целиком.
 * При живом signal предметная/транспортная ошибка возвращается без изменений.
 */
export function executionFailure(
  cause: unknown,
  signal: AbortSignal,
  deadline: AbortSignal,
): unknown {
  if (!signal.aborted || hasSignificantGitFailure(cause)) {
    return cause;
  }
  const timedOut = deadline.aborted && signal.reason === deadline.reason;
  const error = timedOut
    ? new RelayError("GIT_SYNC_TIMEOUT", messages.timeout, 124)
    : new RelayError(
        "GIT_SYNC_CANCELLED",
        messages.cancelled,
        signal.reason === "SIGTERM" ? 143 : 130,
      );
  error.cause = cause;
  return error;
}
