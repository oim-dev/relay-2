/**
 * Отличает отсутствие значения от допустимых нуля и пустой строки.
 */
export const isDefined = <T>(value: T | undefined | null): value is T =>
  value !== undefined && value !== null;

/**
 * Проверяет наличие элементов типизированного массива.
 */
export const isNonEmptyArray = <T>(
  values: readonly T[] | undefined | null,
): values is readonly T[] => Array.isArray(values) && values.length > 0;

/**
 * Определяет пустой либо отсутствующий список.
 */
export const isEmptyArray = (values: readonly unknown[] | undefined | null): boolean =>
  !isNonEmptyArray(values);
