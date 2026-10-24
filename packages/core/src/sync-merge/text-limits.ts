/**
 * Максимальная суммарная длина base/local/remote для нетривиального diff, в UTF-16.
 */
export const maxTextCodeUnits = 8 * 1024 * 1024;

/**
 * Максимальное число токенов одной версии; проверяется во время разбиения строки.
 */
export const maxTextTokens = 100_000;

/**
 * Общий предел сравнений токенов и состояний Myers за один mergeText.
 */
export const maxTextDiffSteps = 2_000_000;

/**
 * Общий предел ячеек трасс Myers: не более 1 МиБ данных Int32Array за один mergeText.
 */
export const maxTextTraceCells = 262_144;

/**
 * Максимальная суммарная длина трёх версий блока для уточнения по словам, в UTF-16.
 */
export const maxTextRefinementCodeUnits = 16_384;
