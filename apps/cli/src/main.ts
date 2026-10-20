import { runCli } from "./run";
import { isBrokenPipe } from "./errors";
import { terminalText } from "./output";

let streamExitCode: number | undefined;
// Ошибка write может прийти событием уже после возврата runCli; обработчик остаётся до выхода.
process.stdout.on("error", (error: Error) => {
  streamExitCode = isBrokenPipe(error) ? 0 : 1;
  process.exitCode = streamExitCode;
  if (streamExitCode !== 0)
    process.stderr.write(`Ошибка: OUTPUT_ERROR: ${terminalText(error.message)}\n`);
});
const exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = streamExitCode ?? exitCode;
