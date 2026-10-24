import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "@relay/contracts";
import {
  buildSourceGuardianComponent,
  combineProcessFailures,
  GuardedCommandError,
  runGuardedCommand,
  sourceGuardianComponent,
  type GuardedCommandOptions,
  type GuardedCommandResult,
} from "@relay/project-runtime";
import { componentCommand } from "./component-command";
import type { GitProcessObservation, GitProcessRuntime } from "./process-runtime.types";
import { transportMessages } from "./transport.messages";

const runtimes = new AsyncLocalStorage<GitProcessRuntime>();

/**
 * Размещает transient source executable в исключённых из Git артефактах его checkout.
 * Fixtures могут явно передать собственный ещё не существующий каталог вместо этого пути.
 */
function sourceDirectory(): string {
  const date = new Date().toISOString().slice(0, 10);
  const parent = fileURLToPath(
    new URL(`../../../../.artifacts/${date}/git-sync-source-runtime/`, import.meta.url),
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return join(parent, `guardian-${process.pid}-${crypto.randomUUID()}`);
}

/**
 * Владеет свежим bytecode helper на весь source-сценарий: одна ленивая сборка для всех Git-команд.
 * Вложенный scope переиспользует владельца; standalone приложение использует свою private роль.
 * При любом исходе ждёт уже начатые команды и удаляет только созданный этим scope каталог.
 * Callback обязан завершить свои workers/engines; новые команды после его выхода отклоняются.
 * Cleanup/observer failures не заменяют primary: обе причины сохраняются; успешный cleanup
 * оставляет исходную ошибку неизменной. Ошибка observer отдельно отклоняет завершение scope,
 * сохраняя первую причину и число отказов, но никогда не меняет результат отдельной команды.
 */
export async function withGitProcessRuntime<T>(
  operation: () => Promise<T>,
  directory?: string,
  observe?: (observation: GitProcessObservation) => void,
): Promise<T> {
  if (runtimes.getStore() !== undefined) {
    return operation();
  }
  let ownedDirectory: string | null = null;
  let preparation: Promise<readonly string[]> | undefined;
  /**
   * Cached status без процессов не создаёт helper; параллельные команды разделяют одну сборку.
   */
  function prepareComponent(): Promise<readonly string[]> {
    if (preparation !== undefined) {
      return preparation;
    }
    if (Bun.isStandaloneExecutable) {
      preparation = Promise.resolve(componentCommand([]));
      return preparation;
    }
    const target = directory ?? sourceDirectory();
    const started = performance.now();
    preparation = buildSourceGuardianComponent(target).then((component) => {
      ownedDirectory = target;
      runtime.preparationMs = performance.now() - started;
      return component;
    });
    return preparation;
  }
  const runtime: GitProcessRuntime = {
    component: prepareComponent,
    preparationMs: 0,
    pending: new Set(),
    closed: false,
    observationFailure: undefined,
    observationFailures: 0,
    ...(observe === undefined ? {} : { observe }),
  };
  let outcome: PromiseSettledResult<T>;
  try {
    outcome = { status: "fulfilled", value: await runtimes.run(runtime, operation) };
  } catch (reason) {
    outcome = { status: "rejected", reason };
  }
  /**
   * Сохраняет приоритет исходной ошибки и присоединяет последующий отказ завершения.
   */
  function failed(error: unknown): void {
    outcome = {
      status: "rejected",
      reason: outcome.status === "rejected" ? combineProcessFailures(outcome.reason, error) : error,
    };
  }
  runtime.closed = true;
  await Promise.allSettled([...runtime.pending]);
  if (ownedDirectory !== null) {
    try {
      rmSync(ownedDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      failed(cleanupError);
    }
  }
  if (runtime.observationFailures > 0) {
    const failure = new RelayError("GIT_OBSERVER_FAILED", transportMessages.observation, 1, {
      failures: runtime.observationFailures,
    });
    failure.cause = runtime.observationFailure;
    failed(failure);
  }
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

/**
 * Делегирует неизменный guarded протокол Runtime и удерживает helper до подтверждённого cleanup.
 * Прямой библиотечный вызов вне scope сохраняет собственный raw source entry Runtime.
 */
export function runGitCommand(
  options: Omit<GuardedCommandOptions, "component">,
): Promise<GuardedCommandResult> {
  const runtime = runtimes.getStore();
  if (runtime?.closed) {
    return Promise.reject(new GuardedCommandError("cancelled"));
  }
  let component: readonly string[] | undefined;
  let started = 0;
  /**
   * Ожидание компиляции не подменяет duration самого runner; оба сегмента наблюдаются отдельно.
   */
  async function execute(): Promise<GuardedCommandResult> {
    if (runtime !== undefined) {
      component = await runtime.component();
    } else {
      component = Bun.isStandaloneExecutable ? componentCommand([]) : sourceGuardianComponent();
    }
    if (component === undefined) {
      throw new GuardedCommandError("guardian");
    }
    started = runtime?.observe === undefined ? 0 : performance.now();
    return runGuardedCommand({ ...options, component });
  }
  const command = execute().then(
    (result) => {
      finished(result);
      return result;
    },
    (error: unknown) => {
      finished(null, error);
      throw error;
    },
  );
  runtime?.pending.add(command);
  /**
   * Фиксирует только метаданные после подтверждённого исхода, не изменяя результат команды.
   */
  function finished(result: GuardedCommandResult | null, error?: unknown): void {
    runtime?.pending.delete(command);
    if (component === undefined || runtime === undefined || runtime.observe === undefined) {
      return;
    }
    try {
      runtime.observe({
        argv: options.argv,
        cwd: options.cwd,
        component,
        helperPreparationMs: runtime.preparationMs,
        elapsedMs: performance.now() - started,
        exitCode: result?.code ?? null,
        failure:
          result !== null ? null : error instanceof GuardedCommandError ? error.reason : "runner",
      });
    } catch (observationError) {
      if (runtime.observationFailures === 0) {
        runtime.observationFailure = observationError;
      }
      runtime.observationFailures++;
    }
  }
  return command;
}
