/**
 * Проверенные параметры страницы компактной проекции.
 */
export interface ViewPageInput {
  /* Смещение от начала. */
  readonly offset: number;
  /* Максимум элементов каждого окна. */
  readonly limit: number;
  /* Поколение продолжения; отсутствие только у начала. */
  readonly generation?: number;
}
