/**
 * Независимый случай намеренного повреждения сохранённого содержания истории.
 */
export interface HistoryCorruptionCase {
  /* Причина повреждения, отображаемая в имени отдельного теста. */
  readonly name: string;
  /* Неверные поля, которыми тест заменяет часть минимальной валидной записи. */
  readonly dataPatch: Readonly<Record<string, unknown>>;
}
