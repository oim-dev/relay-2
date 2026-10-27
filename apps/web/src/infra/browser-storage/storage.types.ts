/**
 * Результат чтения снимка: отсутствие значения отличается от повреждения.
 */
export interface SessionReadResult {
  /* Разобранное значение; undefined при отсутствии записи. */
  readonly value: unknown;
  /* Диагностика повреждения либо null для успешного чтения. */
  readonly error: string | null;
}

/**
 * Хранилище JSON-снимков в памяти одной вкладки; projectId входит в ключ владельца формы.
 */
export interface TabStorage {
  /* Возвращает независимый снимок без доступа к старому browser persistence. */
  readonly read: (key: string) => SessionReadResult;
  /* Сохраняет независимый JSON-снимок; false означает несериализуемый ввод. */
  readonly write: (key: string, value: unknown) => boolean;
  /* Удаляет только ключ текущего origin. */
  readonly remove: (key: string) => void;
}
