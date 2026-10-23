import type { Command } from "gunshi";
import { runCli } from "../../src/app/run";
import type { CliRuntime } from "../../src/execution/runtime.types";
import type { CommandRoute, InvocationResult } from "./run-fixture.types";

export const helpRuntime: CliRuntime = {
  cwd: "/missing-relay-cli-test",
  env: { RELAY_CONFIG: "/missing-relay-config.json" },
  /**
   * Делает ошибкой чтение stdin в автономной справке и при ранней проверке аргументов.
   */
  stdin: (): never => {
    throw new Error("Справка не должна читать stdin");
  },
};

/**
 * Собирает зарегистрированные маршруты для адресных проверок справки без запуска обработчиков.
 */
export function commandRoutes(
  commands: ReadonlyMap<string, Command>,
  path: readonly string[] = [],
): readonly CommandRoute[] {
  const routes: CommandRoute[] = [];
  for (const [name, command] of commands) {
    const argv = [...path, name];
    const children =
      command.subCommands instanceof Map ? command.subCommands : new Map<string, Command>();
    routes.push({ name: argv.join(" "), argv, group: children.size > 0 });
    routes.push(...commandRoutes(children, argv));
  }
  return routes;
}

/**
 * Запускает CLI с недоступным проектом и собственными буферами потоков для каждого вызова.
 */
export async function invokeIsolatedCli(argv: readonly string[]): Promise<InvocationResult> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(
    argv,
    {
      /**
       * Сохраняет полный stdout только этого вызова.
       */
      stdout: (text): void => {
        stdout += text;
      },
      /**
       * Сохраняет полную диагностику только этого вызова.
       */
      stderr: (text): void => {
        stderr += text;
      },
    },
    helpRuntime,
  );
  return { exitCode, stdout, stderr };
}

/**
 * Извлекает копируемую последнюю секцию примеров; пропуск секции считается дефектом справки.
 */
export function helpExamples(stdout: string): string {
  const marker = "ПРИМЕРЫ:\n";
  const index = stdout.indexOf(marker);
  if (index < 0) {
    throw new Error("В справке отсутствует секция примеров");
  }
  return stdout.slice(index + marker.length);
}
