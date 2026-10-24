import { fileURLToPath } from "node:url";

/**
 * Находит собственный compile-бинарник либо исходный main.ts, независимо от запускающего скрипта.
 */
export function componentCommand(args: readonly string[]): string[] {
  if (Bun.isStandaloneExecutable) {
    return [process.execPath, ...args];
  }
  return [process.execPath, fileURLToPath(new URL("../main.ts", import.meta.url)), ...args];
}
