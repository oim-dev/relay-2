import { AsyncLocalStorage } from "node:async_hooks";
import { RelayError } from "@relay/contracts";
import type { GitSyncExecutionOptions } from "./execution.types";
import { executionMessages } from "./execution.messages";

const executions = new AsyncLocalStorage<GitSyncExecutionOptions>();

/**
 * Сохраняет снимок среды/сигнала одного async-вызова; внешние изменения options не затрагивают scope.
 */
export function withGitExecution<T>(
  options: GitSyncExecutionOptions,
  operation: () => Promise<T>,
): Promise<T> {
  return executions.run(
    {
      env: Object.freeze({ ...options.env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    operation,
  );
}

/**
 * Объединяет явный снимок среды обращения с per-command overrides; прямой internal вызов использует среду host.
 */
export function gitExecutionEnvironment(
  overrides?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...(executions.getStore()?.env ?? process.env), ...overrides };
}

/**
 * Добавляет отмену обращения к отдельному Git attempt либо ожиданию mutex.
 */
export function gitExecutionSignal(signal?: AbortSignal): AbortSignal | undefined {
  const execution = executions.getStore()?.signal;
  if (execution !== undefined && signal !== undefined) {
    return AbortSignal.any([execution, signal]);
  }
  return execution ?? signal;
}

/**
 * Не допускает новую запись/подготовку после отмены на границе await.
 * Cleanup и запись уже установленного outcome продолжаются отдельно; I/O-причина при передаче сохраняется.
 */
export function requireGitExecutionActive(cause?: unknown): void {
  const signal = executions.getStore()?.signal;
  if (signal?.aborted) {
    const error = new RelayError("GIT_CANCELLED", executionMessages.cancelled, 1);
    error.cause = cause ?? signal.reason;
    throw error;
  }
}
