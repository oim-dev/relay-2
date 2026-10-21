/**
 * Диагностики SQL-чтения и записи сущностей, ключей и независимого журнала комментариев.
 */
export const entityMessages = {
  revisionConflict: "Запись уже изменена; перечитайте её ревизию.",
  commentRequiresAppend: "Комментарии публикуются отдельной append-only операцией.",
  entityMissing: "Запись не найдена.",
  invalidPrefix: "Некорректный префикс ключа.",
  taskMissing: "Задача не найдена.",
  invalidKey: "Некорректный читаемый ключ.",
  invalidPayload: "Содержание записи в базе должно быть JSON-объектом.",
  counterMissing: "SQLite не вернул выделенный номер ключа.",
  countMissing: "SQLite не вернул число записей.",
  commentTaskMissing: "Задача исчезла после добавления комментария.",

  /**
   * Указывает поле комментария, не прошедшее техническую проверку строки.
   */
  invalidCommentField: (field: string): string => `Поле комментария ${field} должно быть строкой.`,
} as const;
