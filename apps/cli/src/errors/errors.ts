import { RelayError } from "@relay/contracts";
import type { CliFailure, ValidationFailure } from "./errors.types";
import { errorMessages } from "../locales/errors";

/**
 * Определяет закрытие принимающей стороны stdout, например при передаче вывода в head.
 * Такая ошибка записи не означает неуспех выполненной команды.
 */
export function isBrokenPipe(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "EPIPE";
}

/**
 * Ошибка синтаксиса или источника ввода CLI с кодом завершения 2 и подсказкой справки.
 */
export class CliUsageError extends RelayError {
  /* Имя класса для диагностики; машинный контракт определяется унаследованным code. */
  override readonly name = "CliUsageError";

  /**
   * Сохраняет публичную диагностику и необязательную причину отказа внешнего источника.
   */
  constructor(message: string, code = "INVALID_ARGUMENT", options?: ErrorOptions) {
    super(code, message, 2);
    if (options && Object.hasOwn(options, "cause")) {
      this.cause = options.cause;
    }
  }
}

/**
 * Переводит отказ в контракт CLI, сохраняя код, exit code и details предметной ошибки.
 * Сообщение Gunshi применяется только к тому же экземпляру ошибки; неизвестные отказы не скрываются.
 */
export function describeCliFailure(error: unknown, inputFailure?: ValidationFailure): CliFailure {
  const validationFailed = inputFailure !== undefined && error === inputFailure.error;
  const invalidInput = error instanceof CliUsageError || validationFailed;
  let message: string = errorMessages.unknown;
  if (validationFailed) {
    message = inputFailure.message;
  } else if (error instanceof Error) {
    message = error.message;
  }
  if (error instanceof RelayError) {
    return {
      code: error.code,
      exitCode: error.exitCode,
      message,
      invalidInput,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    code: invalidInput ? "INVALID_ARGUMENT" : "INTERNAL_ERROR",
    exitCode: invalidInput ? 2 : 1,
    message,
    invalidInput,
  };
}
