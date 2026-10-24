import { RelayError } from "@relay/contracts";
import {
  runGuardedCommand,
  GuardedCommandError,
  sourceGuardianComponent,
} from "@relay/project-runtime";
import { componentCommand } from "./component-command";
import type { ProcessInput, ProcessResult } from "./process.types";
import { transportMessages } from "./transport.messages";

/**
 * Удаляет пароли, токены URL и заголовки авторизации из диагностических строк.
 */
export function redact(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, "$1***@")
    .replace(/([?&](?:token|access_token|private_token|api_key|password|key)=)[^&\s]+/gi, "$1***")
    .replace(/(authorization:\s*)([^\r\n]+)/gi, "$1***");
}

/**
 * Переводит типизированный отказ guardian в стабильный транспортный код, очищая stderr.
 */
function guardedFailure(error: GuardedCommandError): RelayError {
  const codes = {
    timeout: "GIT_TIMEOUT",
    cancelled: "GIT_CANCELLED",
    "output-limit": "GIT_OUTPUT_LIMIT",
    spawn: "GIT_START_FAILED",
    protocol: "GIT_GUARDIAN_PROTOCOL",
    guardian: "GIT_GUARDIAN_FAILED",
    cleanup: "GIT_CLEANUP_FAILED",
  } as const;
  const messages = {
    timeout: transportMessages.deadline,
    cancelled: transportMessages.aborted,
    "output-limit": transportMessages.outputLimit,
    spawn: transportMessages.startFailed,
    protocol: transportMessages.guardian,
    guardian: transportMessages.guardian,
    cleanup: transportMessages.cleanup,
  } as const;
  const failure = new RelayError(codes[error.reason], messages[error.reason], 1, {
    reason: error.reason,
    stderr: redact(error.stderr.slice(-8192)),
  });
  failure.cause = error;
  return failure;
}

/**
 * Делегирует process lifetime узкому source helper Runtime либо private роли своего compiled binary.
 * При отсутствии source helper отклоняет запуск до target. Deadline, отмена,
 * bounded streams и очистка Git/SSH после смерти владельца имеют единственного владельца.
 * Ненулевой exit самого Git возвращается вызывающему без смешивания с инфраструктурным отказом.
 */
export async function runProcess(input: ProcessInput): Promise<ProcessResult> {
  try {
    const component = Bun.isStandaloneExecutable ? componentCommand([]) : sourceGuardianComponent();
    if (component === undefined) {
      throw new GuardedCommandError("guardian");
    }
    const result = await runGuardedCommand({
      component,
      argv: [input.executable, ...input.args],
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      timeoutMs: input.timeoutMs ?? 30_000,
      maxOutputBytes: input.maxBytes ?? 16 * 1024 * 1024,
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      exitCode: result.code,
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr, "utf8"),
    };
  } catch (error) {
    if (error instanceof GuardedCommandError) {
      throw guardedFailure(error);
    }
    throw error;
  }
}
