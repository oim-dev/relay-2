import { RelayError } from "../errors/relay-error";
import { componentMessages } from "./component.messages";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Проверяет плотную лексикографическую позицию; завершающий минимальный символ запрещён.
 */
export function isComponentPosition(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Za-z]+$/.test(value) && !value.endsWith("0");
}

/**
 * Сравнивает позиции/IDs по code units, независимо от locale и SQLite collation.
 */
export function compareComponentPositions(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Выделяет плотный ключ строго между соседями без изменения их позиций.
 * null обозначает открытую границу; discriminator обеспечивает устойчивые одновременные вставки.
 */
export function componentPositionBetween(
  left: string | null,
  right: string | null,
  discriminator: string,
): string {
  if (
    (left !== null && !isComponentPosition(left)) ||
    (right !== null && !isComponentPosition(right)) ||
    (left !== null && right !== null && left >= right)
  ) {
    throw new RelayError("COMPONENT_POSITION", componentMessages.position, 4);
  }
  let prefix = "";
  let index = 0;
  let upper = right;
  while (true) {
    const low = left === null || index >= left.length ? 0 : alphabet.indexOf(left[index] ?? "0");
    const high = upper === null ? alphabet.length : alphabet.indexOf(upper[index] ?? "0");
    if (high - low > 1) {
      const digit = alphabet[Math.floor((low + high) / 2)];
      if (digit === undefined) {
        throw new Error("COMPONENT_POSITION_INVARIANT");
      }
      const suffix = Array.from(
        { length: discriminator.length },
        (_, offset) => `1${discriminator.charCodeAt(offset).toString(16).padStart(4, "0")}`,
      )
        .join("")
        .toUpperCase();
      return `${prefix}${digit}${suffix}0V`;
    }
    prefix += alphabet[low];
    if (high > low) {
      upper = null;
    }
    index++;
  }
}
