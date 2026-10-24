/**
 * Пользовательские диагностики формы, составов и жизненного цикла планирования.
 */
export const planningMessages = {
  expectedObject: "Ожидается объект полей.",
  expectedPlainObject: "Ожидается обычный объект полей.",
  invalidRevision: "Ожидаемая ревизия должна быть положительным целым числом.",
  invalidPlannedFor: "plannedFor должен быть календарной датой YYYY-MM-DD либо пустой строкой.",
  missingPlanTitle: "Передайте заголовок плана.",
  missingReleaseFields: "Передайте title, version и planIds релиза.",
  missingStageTitle: "Передайте заголовок этапа.",
  emptyUpdate: "Передайте хотя бы одно поле изменения.",
  emptyStageUpdate: "Передайте хотя бы одно поле этапа.",
  invalidStageDestination: "Для перемещения передайте ровно одно поле: before или direction.",
  duplicateStageTask: "Повторное включение задачи в этапы плана.",
  duplicateScope: "Области воздействия не должны повторяться.",
  duplicateReleasePlans:
    "Планы в составе релиза не должны повторяться, включая ссылки по ключу и ID.",
  expectedPlanning: "Ожидается план или релиз.",
  expectedPlan: "Ожидается план.",
  expectedRelease: "Ожидается релиз.",
  wrongProject: "Планирование принадлежит другому проекту.",
  stageNotFound: "Этап не найден в указанном плане.",
  missingTaskProgress: "Не найден прогресс включённой задачи.",
  invalidRemove: "remove должен быть логическим значением.",
  sourceTaskNotFound: "Задача не включена в исходный план.",
  startRequiresDraft: "Начать можно только черновик плана.",
  startRequiresGoalAndTasks: "Для начала плана нужны цель и хотя бы одна задача.",
  planNotReady: "Для завершения плана нужны непустой состав и фактическое выполнение всех задач.",
  releaseRequiresReplanning: "Отменённый релиз сначала нужно явно перепланировать.",
  releaseNotReady: "Выпуск требует завершённых планов с актуально выполненными задачами.",
  revisionConflict: "Запись изменена; перечитайте её перед записью.",
  planReadOnly: "Закрытый план доступен только для чтения.",
  releaseReadOnly: "Выпущенный релиз неизменяем.",
  cancelledReleasePlan: "Нельзя включить отменённый план в релиз.",
  membershipConflict:
    "Задача уже включена в другой открытый план или этап; используйте явный перенос.",
  stageNotEmpty: "Удалить можно только пустой этап.",
  missingScope: "Не найдена цель области плана.",
  missingPlan: "Не найден план состава релиза.",
  missingAllocation: "Не выделен постоянный ID нового этапа.",
  missingContext: "Отсутствуют необходимые основания перехода планирования.",
  invalidTransition: "Изменение не соответствует операции планирования.",
  immutableFields: "Неизменяемые поля планирования изменены.",
  missingResult: "Не найден результат команды планирования.",

  /**
   * Называет поле, не предусмотренное выбранной операцией.
   */
  unknownField: (field: string): string => `Неизвестное поле: ${field}.`,

  /**
   * Отличает явный undefined от отсутствующего необязательного поля.
   */
  undefinedField: (field: string): string => `Поле ${field} не может быть undefined.`,

  /**
   * Описывает общий предел строкового поля и запрет NUL.
   */
  invalidText: (field: string, maximum: number): string =>
    `Поле ${field} должно быть строкой длиной не более ${maximum} без NUL.`,

  /**
   * Сообщает об обязательном непустом тексте.
   */
  emptyText: (field: string): string => `Поле ${field} не должно быть пустым.`,

  /**
   * Сообщает о переводе строки в однострочном поле.
   */
  multilineText: (field: string): string => `Поле ${field} должно занимать одну строку.`,

  /**
   * Перечисляет допустимые предметные значения поля.
   */
  invalidChoice: (field: string, choices: readonly string[]): string =>
    `Поле ${field}: допустимы ${choices.join(", ")}.`,

  /**
   * Описывает допустимую длину списка включительно.
   */
  invalidList: (field: string, minimum: number, maximum: number): string =>
    `Поле ${field}: ожидается массив длиной от ${minimum} до ${maximum}.`,

  /**
   * Сообщает о повторе предметного ключа в списке.
   */
  duplicateListItem: (field: string): string => `Поле ${field}: повторы недопустимы.`,

  /**
   * Называет повреждённую временную отметку хранения.
   */
  invalidTimestamp: (field: string): string => `Повреждена дата ${field}.`,

  /**
   * Добавляет адрес записи к причине отказа декодирования.
   */
  corruptData: (key: string, cause: string): string => `Повреждены данные ${key}: ${cause}`,

  /**
   * Сообщает о заполненном составе этапа.
   */
  stageTaskLimit: (maximum: number): string => `В этапе допускается не более ${maximum} задач.`,

  /**
   * Сообщает о предельном числе этапов плана.
   */
  stageLimit: (maximum: number): string => `В плане допускается не более ${maximum} этапов.`,
} as const;
