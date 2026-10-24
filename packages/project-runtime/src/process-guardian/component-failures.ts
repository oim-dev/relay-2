import { RelayError } from "@relay/contracts";
import { GuardedCommandError } from "./errors";

/**
 * Присоединяет вторичный отказ без мутации исходных ошибок и потери стабильной диагностики primary.
 * RelayError сохраняет code/exitCode/details, GuardedCommandError — reason/native поля и потоки.
 * Обе исходные ошибки вместе с их прежними causes остаются достижимы через AggregateError.errors.
 * Этот модуль относится к caller/build lifetime, не загружается минимальным guardian entry.
 */
export function combineProcessFailures(primary: unknown, secondary: unknown): Error {
  const causes = new AggregateError(
    [primary, secondary],
    primary instanceof Error ? primary.message : undefined,
  );
  if (primary instanceof RelayError) {
    const failure = new RelayError(
      primary.code,
      primary.message,
      primary.exitCode,
      primary.details,
    );
    failure.cause = causes;
    return failure;
  }
  if (primary instanceof GuardedCommandError) {
    return new GuardedCommandError(primary.reason, {
      stdout: primary.stdout,
      stderr: primary.stderr,
      ...(primary.stage === undefined ? {} : { stage: primary.stage }),
      ...(primary.systemCode === undefined ? {} : { systemCode: primary.systemCode }),
      cause: causes,
    });
  }
  return causes;
}
