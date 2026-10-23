import type { CliRuntime } from "./runtime.types";
import { readBoundedText } from "../input/bounded-text";

/**
 * Подключает окружение текущего процесса, не читая stdin до явного запроса команды.
 * Встраиваемые и параллельные вызовы могут передать собственный CliRuntime.
 */
export function processRuntime(): CliRuntime {
  return {
    cwd: process.cwd(),
    env: process.env,
    /**
     * Читает stdin только при выборе «-»; ограниченные команды прекращают поток при превышении.
     */
    stdin: (maxBytes): Promise<string> =>
      maxBytes === undefined ? Bun.stdin.text() : readBoundedText(Bun.stdin.stream(), maxBytes),
  };
}
