import type { CliRuntime } from "./runtime.types";

/**
 * Подключает окружение текущего процесса, не читая stdin до явного запроса команды.
 * Встраиваемые и параллельные вызовы могут передать собственный CliRuntime.
 */
export function processRuntime(): CliRuntime {
  return {
    cwd: process.cwd(),
    env: process.env,
    /**
     * Читает весь стандартный ввод только при выборе источника «-».
     */
    stdin: (): Promise<string> => Bun.stdin.text(),
  };
}
