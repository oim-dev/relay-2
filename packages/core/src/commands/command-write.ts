import { batchText } from "../batch/batch-input";

/**
 * Выбирает явный переносимый token метода либо значение по умолчанию фасада без чтения состояния.
 * Неверное явное значение не заменяется inherited; local ifRevision здесь не создаётся.
 */
export function expectedCommandVersion(explicit: unknown, inherited?: unknown): string | undefined {
  const value = explicit === undefined ? inherited : explicit;
  if (value === undefined) {
    return undefined;
  }
  return batchText(
    value,
    explicit === undefined ? "execution.expectedVersion" : "options.expectedVersion",
  );
}
