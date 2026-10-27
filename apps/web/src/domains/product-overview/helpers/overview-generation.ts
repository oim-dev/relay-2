import { createSnapshotChangedError } from "../errors/product-overview.error";

/**
 * Отказывает составному чтению, если хотя бы одна часть относится к другому поколению.
 */
export function requireOverviewGeneration(expected: number, actual: number): void {
  if (expected !== actual) throw createSnapshotChangedError();
}
