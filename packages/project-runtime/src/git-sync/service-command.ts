import { RelayError } from "@relay/contracts";
import type { GitSyncEnvironment } from "./client.types";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { runNativeProcess } from "./process";
import type { ProcessResult } from "./process.types";

/**
 * Выполняет одну native-команду и сохраняет действительный exit code, argv и stderr при отказе.
 */
export async function runServiceCommand(
  environment: GitSyncEnvironment,
  executable: string,
  args: readonly string[],
  allowed: readonly number[] = [0],
): Promise<ProcessResult> {
  const result = await (environment.runner ?? runNativeProcess)({
    executable,
    args,
    cwd: environment.cwd,
    env: environment.env,
    timeoutMs: environment.timeoutMs ?? 30_000,
    ...(environment.signal ? { signal: environment.signal } : {}),
  });
  if (!allowed.includes(result.exitCode)) {
    throw new RelayError("GIT_SYNC_SERVICE_FAILED", messages.nativeFailed, result.exitCode || 1, {
      executable,
      args,
      stderr: result.stderr,
      stdout: result.stdout,
      nativeExitCode: result.exitCode,
    });
  }
  return result;
}
