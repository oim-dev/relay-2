import { format } from "node:util";
import { runProcessCli } from "./app/process-run";
import { isBrokenPipe } from "./errors/errors";
import { terminalText } from "./output/output";
import { errorMessages } from "./locales/errors";

let streamExitCode: number | undefined;

/**
 * Обрабатывает поздние ошибки процессного stdout, включая события после возврата обработчика CLI.
 * EPIPE сохраняет успешное завершение; иной отказ потока задаёт код 1 и пишет диагностику в stderr.
 * Первый отказ определяет результат; повторные события не дублируют диагностику.
 * Обработчик остаётся установленным до выхода процесса, чтобы не потерять отложенное событие write.
 */
function onStdoutError(error: Error): void {
  if (streamExitCode !== undefined) {
    return;
  }
  streamExitCode = isBrokenPipe(error) ? 0 : 1;
  process.exitCode = streamExitCode;
  if (streamExitCode !== 0) {
    process.stderr.write(errorMessages.failure("OUTPUT_ERROR", terminalText(error.message)));
  }
}

/**
 * Связывает console.log сторонних плагинов с контролируемым stdout процесса.
 * Bun console.log может скрывать отказы записи; process.stdout передаёт их onStdoutError.
 * Привязка выполняется один раз в исполняемом entrypoint, вне изолированного runCli.
 */
function writeConsoleLine(...values: unknown[]): void {
  try {
    process.stdout.write(`${format(...values)}\n`);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    onStdoutError(error);
  }
}

process.stdout.on("error", onStdoutError);
console.log = writeConsoleLine;
const exitCode = await runProcessCli(process.argv.slice(2), {
  /**
   * Передаёт успешный результат процессному stdout; поздние отказы ловит onStdoutError.
   */
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  /**
   * Передаёт диагностику процессному stderr без изменения её формата.
   */
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
});
process.exitCode = streamExitCode ?? exitCode;
