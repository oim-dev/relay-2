import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Возвращает собственный source entry Runtime только при наличии настоящего исходного файла.
 * Отсутствие файла и standalone executable дают undefined без запуска процесса.
 * Compiled embedding обязан явно передать доверенный component со своей private ролью.
 */
export function sourceGuardianComponent(): readonly string[] | undefined {
  if (Bun.isStandaloneExecutable) {
    return undefined;
  }
  const entry = fileURLToPath(new URL("./source-entry.ts", import.meta.url));
  return existsSync(entry) ? [process.execPath, entry] : undefined;
}
