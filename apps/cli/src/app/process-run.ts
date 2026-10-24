import { processRuntime } from "../execution/runtime";
import { enableCompletion } from "./completion";
import { createProgram } from "./program";
import { runProgram } from "./run";
import type { CliOutput } from "./run.types";

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
 */
export async function runProcessCli(argv: readonly string[], output: CliOutput): Promise<number> {
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
