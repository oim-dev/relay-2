import { cli } from "gunshi";
import { renderValidationErrors } from "gunshi/renderer";
import { describeCliFailure, isBrokenPipe } from "../errors/errors";
import type { ValidationFailure } from "../errors/errors.types";
import { errorMessages } from "../locales/errors";
import { terminalText } from "../output/output";
import { createProgram } from "./program";
import type { CliOutput } from "./run.types";
import { processRuntime } from "../execution/runtime";
import type { CliRuntime } from "../execution/runtime.types";
import type { CliProgram } from "./program.types";

export type { CliRuntime } from "../execution/runtime.types";
export type { CliOutput } from "./run.types";

/**
 * Выполняет один изолированный запуск CLI без изменения cwd, env, console и exitCode процесса.
 * Gunshi возвращает текст, а переданные потоки получают результат либо единую диагностику.
 * Синхронный EPIPE stdout означает успешное прекращение чтения; остальные ошибки сохраняют отказ.
 * Поздние события ошибок процессного stdout обрабатывает исполняемый main, а не этот API.
 */
export async function runCli(
  argv: readonly string[],
  output: CliOutput,
  runtime: CliRuntime = processRuntime(),
): Promise<number> {
  return runProgram(argv, output, () => createProgram(runtime));
}

/**
 * Создаёт и выполняет программу с общей обработкой результата, диагностики и EPIPE.
 * Процессный вход может подключать плагины с собственным stdout; изолированный runCli
 * передаёт только плагины, использующие явные потоки. Программа принадлежит одному запуску.
 */
export async function runProgram(
  argv: readonly string[],
  output: CliOutput,
  create: () => CliProgram,
): Promise<number> {
  let inputFailure: ValidationFailure | undefined;
  let format = "text";
  try {
    const { command, options } = create();
    const result = await cli([...argv], command, {
      ...options,
      /**
       * Запоминает формат текущего вызова до собственной проверки позиционных аргументов.
       */
      onBeforeCommand(ctx): void {
        format = ctx.values.format === "json" ? "json" : "text";
        options.onBeforeCommand(ctx);
      },
      /**
       * Сохраняет локализованную диагностику вместе с исходной ошибкой только этого запуска.
       */
      renderValidationErrors: async (ctx, error): Promise<string> => {
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
        if (isBrokenPipe(error)) {
          return 0;
        }
        throw error;
      }
    }
    return 0;
  } catch (error) {
    const failure = describeCliFailure(error, inputFailure);
    if (format === "json") {
      const { code, message, details } = failure;
      output.stderr(
        `${JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } })}\n`,
      );
    } else {
      output.stderr(errorMessages.failure(failure.code, terminalText(failure.message)));
      if (failure.invalidInput) {
        output.stderr(errorMessages.help);
      }
    }
    return failure.exitCode;
  }
}
