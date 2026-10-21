/**
 * Диагностики жизненного цикла файловой базы, транзакций и начальные подписи проекта.
 */
export const projectDatabaseMessages = {
  walUnavailable: "Не удалось включить WAL для базы проекта.",
  databaseExists: "Файл базы данных уже существует.",
  notAFile: "Путь базы данных не является файлом.",
  foreignDatabase: "Файл не является базой проекта Relay.",
  unsupportedSchema: "Версия схемы базы не поддерживается.",
  projectMissing: "В базе отсутствует проект.",
  databaseMissing: "База проекта не найдена.",
  transactionActive: "Нельзя закрыть базу внутри транзакции.",
  databaseClosed: "Соединение с базой уже закрыто.",
  asyncCallback: "Транзакция принимает только синхронную функцию.",
  asyncResult: "Транзакция не может возвращать Promise.",
  transactionAborted: "Внешняя транзакция уже отменена SQLite.",
  generationMissing: "В базе отсутствует поколение проекта.",
  productBoardName: "Продукт",

  /**
   * Указывает обязательное поле метаданных, отсутствующее при создании базы.
   */
  missingProjectField: (field: string): string => `Не задано поле проекта: ${field}.`,
} as const;
