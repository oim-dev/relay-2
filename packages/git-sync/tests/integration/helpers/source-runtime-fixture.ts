import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Создаёт отдельный root для fresh helper и target; caller восстанавливает fault injection до cleanup.
 */
export async function withRuntimeDirectory(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const parent = fileURLToPath(
    new URL(
      `../../../../../.artifacts/${new Date().toISOString().slice(0, 10)}/git-sync-implementation/git-sync/source-runtime/`,
      import.meta.url,
    ),
  );
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "runtime-"));
  try {
    await operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Проверяет достижимость исходной причины, не требуя конкретной глубины объединённых ошибок.
 */
export function containsFailure(
  value: unknown,
  expected: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (value === expected) {
    return true;
  }
  if (!(value instanceof Error) || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return (
    containsFailure(value.cause, expected, seen) ||
    (value instanceof AggregateError &&
      value.errors.some((error: unknown) => containsFailure(error, expected, seen)))
  );
}
