import { runCli } from "./app/run";
import { isBrokenPipe } from "./errors/errors";
import { terminalText } from "./output/output";
import { errorMessages } from "./locales/errors";

let streamExitCode: number | undefined;

/**
 * Обрабатывает поздние ошибки процессного stdout, включая события после возврата runCli.
 * EPIPE сохраняет успешное завершение; иной отказ потока задаёт код 1 и пишет диагностику в stderr.
 * Обработчик остаётся установленным до выхода процесса, чтобы не потерять отложенное событие write.
 */
function onStdoutError(error: Error): void {
  streamExitCode = isBrokenPipe(error) ? 0 : 1;
  process.exitCode = streamExitCode;
  if (streamExitCode !== 0) {
    process.stderr.write(errorMessages.failure("OUTPUT_ERROR", terminalText(error.message)));
  }
}

process.stdout.on("error", onStdoutError);
const exitCode = await runCli(process.argv.slice(2), {
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
