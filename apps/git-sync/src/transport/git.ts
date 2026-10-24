import { RelayError } from "@relay/contracts";
import { runProcess, redact } from "./process";
import type { ProcessInput, ProcessResult } from "./process.types";
import { transportMessages } from "./transport.messages";

/**
 * Запускает Git с отключёнными интерактивными запросами, внешними diff и наследованием GIT_DIR.
 * Полученные exit codes не превращаются в «ветка отсутствует»: это решает конкретная команда.
 */
export function gitCommand(
  cwd: string,
  args: readonly string[],
  options: Omit<ProcessInput, "cwd" | "executable" | "args"> = {},
): ProcessInput {
  return {
    ...options,
    executable: "git",
    cwd,
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "gc.autoDetach=false",
      "-c",
      "maintenance.autoDetach=false",
      ...args,
    ],
    env: {
      ...options.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_SHALLOW_FILE: undefined,
      GIT_GRAFT_FILE: undefined,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      LC_ALL: "C",
    },
  };
}

/**
 * Выполняет проверяемый per-call Git профиль; пользовательские SSH/credential настройки сохраняются.
 */
export function git(
  cwd: string,
  args: readonly string[],
  options: Omit<ProcessInput, "cwd" | "executable" | "args"> = {},
): Promise<ProcessResult> {
  return runProcess(gitCommand(cwd, args, options));
}

/**
 * Требует успешную Git-команду, сохраняя полезную ограниченную и очищенную диагностику.
 */
export function checkGit(result: ProcessResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new RelayError("GIT_FAILED", transportMessages.failed, 1, {
      operation,
      exitCode: result.exitCode,
      reason: redact(result.stderr.subarray(-8192).toString("utf8")),
    });
  }
}

/**
 * Получает успешный короткий текстовый результат; для binary blobs используется checkGit.
 */
export function requireGit(result: ProcessResult, operation: string): string {
  checkGit(result, operation);
  return result.stdout.toString("utf8").trim();
}

/**
 * Разрешает origin только относительно code cwd; частный репозиторий не зависит от checkout.
 */
export async function resolveRemote(cwd: string, remote: string): Promise<string> {
  if (!remote || remote.includes("\0") || remote.startsWith("-")) {
    throw new RelayError("INVALID_ARGUMENT", transportMessages.remoteRequired, 2);
  }
  if (remote !== "origin") {
    return remote;
  }
  return requireGit(await git(cwd, ["remote", "get-url", "origin"]), "resolve-origin");
}

/**
 * Проверяет ref стандартным Git; псевдоаргументы и полные refs не принимаются.
 */
export async function validateBranch(cwd: string, branch: string): Promise<void> {
  if (branch.startsWith("-") || branch.startsWith("refs/") || branch.includes("\0")) {
    throw new RelayError("INVALID_ARGUMENT", transportMessages.invalidBranch, 2);
  }
  const result = await git(cwd, ["check-ref-format", `refs/heads/${branch}`]);
  if (result.exitCode !== 0) {
    throw new RelayError("INVALID_ARGUMENT", transportMessages.invalidBranch, 2);
  }
}
