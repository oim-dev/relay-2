import { cli } from "gunshi";
import { renderValidationErrors } from "gunshi/renderer";
import { CliUsageError, isBrokenPipe } from "./errors";
import { RelayError } from "@relay/contracts";
import { createProgram } from "./program";
import { processRuntime, type CliRuntime } from "./runtime";
import { terminalText } from "./output";

export type { CliRuntime } from "./runtime";

export interface CliOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Gunshi возвращает текст; потоками и кодом завершения управляет приложение. */
export async function runCli(
  argv: readonly string[],
  output: CliOutput,
  runtime: CliRuntime = processRuntime(),
): Promise<number> {
  let inputFailure: { error: AggregateError; message: string } | undefined;
  let format = "text";

  try {
    const { command, options } = createProgram(runtime);
    const result = await cli([...argv], command, {
      ...options,
      onBeforeCommand(ctx) {
        format = ctx.values.format === "json" ? "json" : "text";
        options.onBeforeCommand(ctx);
      },
      renderValidationErrors: async (ctx, error) => {
        format = ctx.values.format === "json" ? "json" : "text";
        const message = await renderValidationErrors(ctx, error);
        inputFailure = { error, message };
        return message;
      },
    });

    if (result) {
      try {
        output.stdout(result.endsWith("\n") ? result : `${result}\n`);
      } catch (error) {
        if (isBrokenPipe(error)) return 0;
        throw error;
      }
    }
    return 0;
  } catch (error) {
    const invalidInput =
      error instanceof CliUsageError || (inputFailure && error === inputFailure.error);
    const message =
      inputFailure && error === inputFailure.error
        ? inputFailure.message
        : error instanceof Error
          ? error.message
          : "Неизвестная ошибка";

    const code =
      error instanceof RelayError
        ? error.code
        : invalidInput
          ? "INVALID_ARGUMENT"
          : "INTERNAL_ERROR";
    const exitCode = error instanceof RelayError ? error.exitCode : invalidInput ? 2 : 1;
    if (format === "json") {
      output.stderr(
        `${JSON.stringify({ ok: false, error: { code, message, ...(error instanceof RelayError && error.details ? { details: error.details } : {}) } })}\n`,
      );
    } else {
      output.stderr(`Ошибка: ${code}: ${terminalText(message)}\n`);
      if (invalidInput) output.stderr("Справка: relay --help\n");
    }
    return exitCode;
  }
}
