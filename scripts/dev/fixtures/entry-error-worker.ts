import { mock } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ParentProcessObservation } from "@relay/project-runtime";
import type { DevelopmentEnvironment, DevelopmentOptions } from "../dev.types";

const controller = new AbortController();
const nativeFailure = new Error("Намеренный отказ native-наблюдения");
const observationFailure = Object.assign(
  new Error("Намеренный отказ наблюдения родителя", { cause: nativeFailure }),
  { code: "PROCESS_PARENT_OBSERVATION_FAILED" },
);
const cleanupFailure = new Error("Намеренный отказ guardian cleanup");
let disposed = 0;
let forwardedAbort = false;
let reported: unknown;
let errorReports = 0;

/**
 * Обходит фактическую композицию причин, не требуя конкретного числа вложенных AggregateError.
 * Идентичности исходных ошибок позволяют отличить сохранённую причину от нового текста о ней.
 */
function errorTree(error: unknown): unknown[] {
  const nested = error instanceof AggregateError ? error.errors.flatMap(errorTree) : [];
  if (error instanceof Error && error.cause !== undefined) {
    nested.push(...errorTree(error.cause));
  }
  return [error, ...nested];
}

// Модули подменяются только в отдельном процессе; общий Bun test не наследует mock.module.
mock.module("@relay/project-runtime", () => ({
  /**
   * Подменяет native-источник signal; production entry сам связывает его с session.
   */
  observeParentProcess(): ParentProcessObservation {
    return {
      signal: controller.signal,
      /**
       * Учитывает освобождение наблюдения при одновременных отказах.
       */
      dispose(): void {
        disposed += 1;
      },
    };
  },
}));
mock.module(fileURLToPath(new URL("../session.ts", import.meta.url)), () => ({
  /**
   * Имитирует отказ наблюдения после старта session и отдельный отказ её guardian cleanup.
   * Проект, CLI compile-watch и Vite не запускаются: проверяется только композиция entry.
   */
  async runDevelopmentSession(
    _options: DevelopmentOptions,
    environment: DevelopmentEnvironment,
  ): Promise<never> {
    controller.abort(observationFailure);
    forwardedAbort = environment.signal.aborted && environment.signal.reason === observationFailure;
    throw new AggregateError([cleanupFailure], "Отказ завершения dev-команды");
  },
}));

const originalError = console.error;
/**
 * Наблюдает настоящий итоговый Error, не привязывая тест к форматированию stack trace Bun.
 */
console.error = (error: unknown): void => {
  reported = error;
  errorReports += 1;
};
try {
  await import("../../dev");
} finally {
  console.error = originalError;
}

const errors = errorTree(reported);
await Bun.write(
  Bun.stdout,
  `${JSON.stringify({
    aggregate: reported instanceof AggregateError,
    observation: errors.includes(observationFailure),
    nativeCause: errors.includes(nativeFailure),
    cleanup: errors.includes(cleanupFailure),
    forwardedAbort,
    disposed,
    errorReports,
  })}\n`,
);
// process.exitCode остаётся установленным настоящим entry; fixture не подменяет исход успешным exit.
