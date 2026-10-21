import { processRuntime } from "../execution/runtime";
import { enableCompletion } from "./completion";
import { createProgram } from "./program";
import { runProgram } from "./run";
import type { CliOutput } from "./run.types";

/**
 * Запускает CLI в отдельном процессе, подключая нативный shell completion Gunshi.
 * Плагин пишет кандидатов и часть shell-скриптов напрямую в процессный stdout;
 * обычные команды и диагностика используют переданные потоки. runCli остаётся изолированным.
 */
export async function runProcessCli(argv: readonly string[], output: CliOutput): Promise<number> {
  return runProgram(argv, output, () => {
    const program = createProgram(processRuntime());
    enableCompletion(program);
    return program;
  });
}
