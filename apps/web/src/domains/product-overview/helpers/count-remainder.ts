import type { OverviewCount } from "../types/overview-sources.type";

/**
 * Получает последнюю категорию закрытого перечисления из полного total и остальных
 * непересекающихся категорий одного generation. Несогласованность не обнуляется.
 */
export function countRemainder(total: number, ...parts: number[]): OverviewCount {
  const remaining = total - parts.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(remaining) || remaining < 0)
    throw new Error("Счётчики категорий обзора не согласованы.");
  return { total: remaining };
}
