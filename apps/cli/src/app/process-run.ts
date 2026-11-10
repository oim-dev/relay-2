import { processRuntime } from "../execution/runtime";
import { enableCompletion } from "./completion";
import { createProgram } from "./program";
import { runProgram } from "./run";
import type { CliOutput } from "./run.types";
import { runGitSyncRequest, runGitSyncSshProbe } from "./git-sync-request";

/**
 * Передаёт SIGINT/SIGTERM только активному process-action и снимает listeners при любом исходе.
 * Обычный runCli не использует эту область и не меняет глобальные обработчики процесса.
 */
async function withProcessSignals<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  /**
   * Прокидывает SIGINT процессному порту, который завершает принадлежащее запуску дерево.
   */
  const interrupt = (): void => controller.abort("SIGINT");
  /**
   * Прокидывает SIGTERM с сохранением соответствующего кода завершения.
   */
  const terminate = (): void => controller.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await operation(controller.signal);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

/**
 * Подключает completion и ленивую область сигналов только для process-actions.
 * Справка, версия, обычные команды и ожидание stdin сохраняют стандартное поведение ОС.
 * Private --git-sync-request обслуживает общий wire до Gunshi, без предметного auto-hook.
 */
export async function runProcessCli(argv: readonly string[], output: CliOutput): Promise<number> {
  if (argv[0] === "--ssh-profile" && argv.length <= 2) {
    return runGitSyncSshProbe(output, argv[1]);
  }
  if (argv.length === 1 && argv[0] === "--git-sync-request") {
    return withProcessSignals((signal) =>
      runGitSyncRequest({ ...processRuntime(), signal }, output),
    );
  }
  return runProgram(argv, output, () => {
    const program = createProgram({
      ...processRuntime(),
      withProcessSignals,
      stdout: output.stdout,
      stderr: output.stderr,
    });
    enableCompletion(program);
    return program;
  });
}
