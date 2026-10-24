/**
 * Заголовки и подписи адресного чтения; содержание сущности форматируется общим макетом.
 */
export const readOutputMessages = {
  /**
   * Отделяет переносимые версии от полей сущности и указывает токен для записи.
   */
  versions: (record: string, aggregate: string): string =>
    `Версия записи: ${record}\nВерсия агрегата (expectedVersion): ${aggregate}`,
  /**
   * Начинает отдельный результат с порядковым номером и дословным адресом в JSON-кавычках.
   */
  begin: (fence: string, index: number, ref: string): string =>
    `${fence} GET ${index} НАЧАЛО · адрес ${ref} ${fence}`,
  /**
   * Сохраняет ключ, вид и постоянный ID даже в краткой карточке.
   */
  identity: (key: string, kind: string, id: string): string => `${key} [${kind}] · ID ${id}`,
  /**
   * Показывает ошибку адреса на его исходном месте в наборе.
   */
  failure: (code: string, message: string): string => `Ошибка [${code}]: ${message}`,
} as const;
