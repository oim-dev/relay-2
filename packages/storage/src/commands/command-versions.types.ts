/**
 * Переносимая версия primary owner, выбранного исходным запросом команды.
 */
export interface CommandRecordVersionRow {
  /* Постоянный ID уже выбранного владельца, не пользовательский адрес. */
  readonly id: string;
  /* Сохранённая переносимая версия; null означает повреждение обязательного индекса версий. */
  readonly recordVersion: string | null;
}
