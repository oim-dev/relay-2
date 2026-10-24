import { RelayError } from "@relay/contracts";
import { GuardedCommandError } from "../process-guardian/errors";
import { sourceGuardianComponent } from "../process-guardian/component";
import { runGuardedCommand } from "../process-guardian/runner";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { processMessages } from "./process.messages";
import type { ProcessCommand, ProcessResult, ProcessRunner } from "./process.types";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TERMINATION_GRACE_MS = 500;

/**
 * Преобразует инфраструктурный отказ guardian, сохраняя коды Runtime и raw-byte бюджет потоков.
 */
function processFailure(error: GuardedCommandError, command: ProcessCommand): RelayError {
  const codes = {
    timeout: "GIT_SYNC_TIMEOUT",
    cancelled: "GIT_SYNC_CANCELLED",
    "output-limit": "GIT_SYNC_OUTPUT_LIMIT",
    protocol: "GIT_SYNC_PROTOCOL_ERROR",
    spawn: "GIT_SYNC_SPAWN_FAILED",
    guardian: "GIT_SYNC_GUARDIAN_FAILED",
    cleanup: "GIT_SYNC_TERMINATION_FAILED",
  } as const;
  const texts = {
    timeout: messages.processTimeout,
    cancelled: messages.processCancelled,
    "output-limit": messages.outputLimit,
    protocol: messages.invalidResponse,
    spawn: messages.processFailed,
    guardian: processMessages.guardianFailed,
    cleanup: processMessages.cleanupFailed,
  } as const;
  let exitCode = 1;
  if (error.reason === "timeout") {
    exitCode = 124;
  }
  if (error.reason === "cancelled") {
    exitCode = command.signal?.reason === "SIGTERM" ? 143 : 130;
  }
  const failure = new RelayError(codes[error.reason], texts[error.reason], exitCode, {
    stderr: error.stderr,
    ...(error.stage === undefined ? {} : { stage: error.stage }),
    ...(error.systemCode === undefined ? {} : { systemCode: error.systemCode }),
  });
  failure.cause = error;
  return failure;
}

/**
 * Собирает runner с явно доверенной private ролью compiled приложения.
 * Проверяемый сторонний executable не становится guardian; контекст команды не меняется.
 */
export function createNativeProcessRunner(guardianComponent: readonly string[]): ProcessRunner {
  const component = [...guardianComponent];
  return (command): Promise<ProcessResult> =>
    runNativeProcess({ ...command, guardianComponent: component });
}

/**
 * Запускает native-команду через доверенный Runtime guardian с отдельным stdin и bounded output.
 * Deadline/cancel имеют ограниченные graceful, force и drain этапы; close чужого inherited pipe
 * не является условием бесконечного ожидания. strictStdout проверяет исходный UTF-8 без замены.
 * Потомки очищаются при любом exit. Постоянные процессы создаёт независимый supervisor/broker.
 */
export async function runNativeProcess(command: ProcessCommand): Promise<ProcessResult> {
  if (command.signal?.aborted) {
    throw new RelayError(
      "GIT_SYNC_CANCELLED",
      messages.processCancelled,
      command.signal.reason === "SIGTERM" ? 143 : 130,
    );
  }
  const component = command.guardianComponent ?? sourceGuardianComponent();
  if (!component) {
    throw new RelayError("GIT_SYNC_GUARDIAN_REQUIRED", processMessages.guardianRequired);
  }
  const stdoutDecoder = new TextDecoder("utf-8", {
    fatal: command.strictStdout ?? false,
    ignoreBOM: true,
  });
  const stderrDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const cancellation = new AbortController();
  let writerFailure: unknown;
  let writerFailed = false;
  /**
   * Декодирует streaming-часть с сохранением UTF-8 границ и исходной ошибки получателя.
   */
  function stream(chunk: Uint8Array, name: "stdout" | "stderr"): void {
    try {
      const decoder = name === "stdout" ? stdoutDecoder : stderrDecoder;
      const write = name === "stdout" ? command.stdout : command.stderr;
      write?.(decoder.decode(chunk, { stream: true }));
    } catch (error) {
      writerFailed = true;
      writerFailure = error;
      throw error;
    }
  }
  /**
   * Дописывает остаток streaming-декодера, сохраняя ошибку пользовательского получателя.
   */
  function flush(name: "stdout" | "stderr"): void {
    const write = name === "stdout" ? command.stdout : command.stderr;
    if (!write) {
      return;
    }
    try {
      const tail = (name === "stdout" ? stdoutDecoder : stderrDecoder).decode();
      if (tail) {
        write(tail);
      }
    } catch (error) {
      writerFailed = true;
      writerFailure = error;
      throw error;
    }
  }
  /**
   * Сохраняет прежнюю семантику Native: отмена без SIGTERM означает SIGINT, а не EOF владельца.
   */
  function cancel(): void {
    cancellation.abort(command.signal?.reason === "SIGTERM" ? "SIGTERM" : "SIGINT");
  }
  command.signal?.addEventListener("abort", cancel, { once: true });
  if (command.signal?.aborted) {
    cancel();
  }
  try {
    const result = await runGuardedCommand({
      component,
      argv: [command.executable, ...command.args],
      cwd: command.cwd,
      env: command.env,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: 2 * MAX_OUTPUT_BYTES,
      maxOutputBytesPerStream: MAX_OUTPUT_BYTES,
      terminationGraceMs: TERMINATION_GRACE_MS,
      stdinLease: command.stdinLease ?? false,
      strictStdout: command.strictStdout ?? false,
      ...(command.input === undefined ? {} : { input: command.input }),
      ...(command.signal === undefined ? {} : { signal: cancellation.signal }),
      ...(command.stdout ? { stdout: (chunk: Uint8Array): void => stream(chunk, "stdout") } : {}),
      ...(command.stderr ? { stderr: (chunk: Uint8Array): void => stream(chunk, "stderr") } : {}),
    });
    flush("stdout");
    flush("stderr");
    return {
      exitCode: result.code,
      stdout: command.stdout ? "" : stdoutDecoder.decode(result.stdout),
      stderr: result.stderr,
    };
  } catch (error) {
    if (writerFailed) {
      throw writerFailure;
    }
    if (error instanceof GuardedCommandError) {
      throw processFailure(error, command);
    }
    if (error instanceof TypeError && command.strictStdout) {
      const failure = new RelayError("GIT_SYNC_PROTOCOL_ERROR", messages.invalidResponse);
      failure.cause = error;
      throw failure;
    }
    throw error;
  } finally {
    command.signal?.removeEventListener("abort", cancel);
  }
}
