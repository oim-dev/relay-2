import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Изолирует файловый/control сценарий без Git и SQLite проекта; callback закрывает своих владельцев до cleanup.
 */
export async function withExchangeDirectory(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const parent = fileURLToPath(
    new URL(
      `../../../../../.artifacts/${new Date().toISOString().slice(0, 10)}/project-local-sync/exchange-review/fixtures/`,
      import.meta.url,
    ),
  );
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "exchange-"));
  try {
    await operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
