import { fileURLToPath } from "node:url";

/**
 * Находит private роли compiled CLI либо source helper пакета, независимо от запускающего скрипта.
 */
export function componentCommand(args: readonly string[]): string[] {
  if (Bun.isStandaloneExecutable) {
    return [process.execPath, ...args];
  }
  return [
    process.execPath,
    fileURLToPath(new URL("../execution/helper.ts", import.meta.url)),
    ...args,
  ];
}
