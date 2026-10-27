import type { UserServiceCommandResult, UserServiceContext } from "./service.types";

/**
 * Выполняет команду manager через явный порт; сохраняет argv, stdout/stderr и настоящий native exit.
 * failureExitCode задан только для прежнего контракта Server POSIX, возвращающего exit 4.
 */
export async function runUserServiceCommand(
  context: UserServiceContext,
  executable: string,
  args: readonly string[],
  allowed: readonly number[] = [0],
  failureExitCode?: number,
): Promise<UserServiceCommandResult> {
  const result = await context.run({ executable, args, timeoutMs: context.timeoutMs });
  if (!allowed.includes(result.exitCode)) {
    throw context.failure("command", failureExitCode ?? (result.exitCode || 1), {
      executable,
      args,
      stderr: result.stderr,
      stdout: result.stdout,
      nativeExitCode: result.exitCode,
    });
  }
  return result;
}
