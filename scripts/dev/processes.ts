import {
  GuardedCommandError,
  runGuardedCommand,
  sourceGuardianComponent,
} from "@relay/project-runtime";
import { developmentMessages as messages } from "./dev.messages";
import type { DevelopmentEnvironment } from "./dev.types";

/**
 * Запускает foreground-команду под существующим Runtime guardian. Потоки не накапливаются;
 * при отмене и потере координатора guardian закрывает собственное дерево, включая Bun/Vite watchers.
 * Ошибка cleanup сохраняется; только подтверждённая отмена считается штатным завершением.
 */
export async function runDevelopmentProcess(
  name: string,
  argv: readonly string[],
  cwd: string,
  environment: DevelopmentEnvironment,
  signal: AbortSignal,
  persistent: boolean,
): Promise<void> {
  const component = sourceGuardianComponent();
  if (component === undefined) {
    throw new Error(messages.readiness("Runtime guardian"));
  }
  try {
    const result = await runGuardedCommand({
      component,
      argv,
      cwd,
      env: environment.env,
      stdinLease: true,
      timeoutMs: persistent ? null : 120_000,
      maxOutputBytes: 0,
      terminationGraceMs: 10_000,
      signal,
      /**
       * Передаёт stdout без накопления журнала команды.
       */
      stdout: (chunk): void => {
        process.stdout.write(chunk);
      },
      /**
       * Сохраняет отдельный диагностический поток дочернего процесса.
       */
      stderr: (chunk): void => {
        process.stderr.write(chunk);
      },
    });
    if (!signal.aborted && (persistent || result.code !== 0)) {
      throw new Error(messages.exited(name, result.code));
    }
  } catch (error) {
    if (signal.aborted && error instanceof GuardedCommandError && error.reason === "cancelled") {
      return;
    }
    throw error;
  }
}
