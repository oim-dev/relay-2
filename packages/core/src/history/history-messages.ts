/**
 * Диагностики внешнего ввода истории; имена полей остаются техническими обозначениями API.
 */
export const historyInputMessages = {
  inputLabel: "Ввод",
  writeOptionsLabel: "Параметры записи",
  revisionRequired: "ifRevision: требуется положительная целая ревизия сессии.",
  unknownSessionAction: "Неизвестное действие сессии.",
  unknownCheckpointAction: "Неизвестное действие точки работы.",
  unfinishedBooleanRequired: "unfinished: ожидается логическое значение.",
  includeChildrenBooleanRequired: "includeChildren: ожидается boolean.",
  runRequired: "runId: требуется постоянный ID текущего участия.",
  inactiveRunForbidden: "У pending/paused-сессии нет текущего run; не передавайте runId.",
  intentRequired: "Ссылка должна указывать на исходный intent.",
  duplicateReference: "references: одна запись указана несколько раз.",
  acceptedIdRequired: "acceptedSessionIds принимает постоянные ID, а не ключи или адреса.",

  /**
   * Описывает отсутствие объекта на внешней границе.
   */
  objectRequired: (label: string): string => `${label}: ожидается объект.`,

  /**
   * Описывает объект с недопустимым прототипом.
   */
  plainObjectRequired: (label: string): string => `${label}: ожидается обычный объект.`,

  /**
   * Называет поле, не принадлежащее контракту команды.
   */
  unknownField: (label: string, key: PropertyKey): string =>
    `${label}: неизвестное поле ${String(key)}.`,

  /**
   * Описывает обязательный текст, не допускающий пустое содержание.
   */
  textRequired: (label: string): string => `${label}: требуется непустой текст.`,

  /**
   * Описывает нарушение однострочного формата.
   */
  singleLineRequired: (label: string): string => `${label}: требуется одна строка.`,

  /**
   * Описывает неверную форму списка адресов.
   */
  referencesArrayRequired: (label: string): string =>
    `${label}: ожидается массив постоянных ID или ссылок.`,

  /**
   * Описывает повторение элементов списка.
   */
  duplicateValues: (label: string): string => `${label}: повторяющиеся значения.`,

  /**
   * Описывает значение вне предметного перечисления.
   */
  unknownValue: (label: string): string => `${label}: неизвестное значение.`,
} as const;

/**
 * Диагностики владения, переходов и закрытия истории.
 */
export const historyStateMessages = {
  revisionConflict: "Ревизия сессии изменилась. Перечитайте её состояние и историю.",
  closedSession: "Завершённая или отменённая сессия неизменяема.",
  openSessionRequired: "Владельческая запись требует открытой сессии с текущим участием.",
  currentRunRequired: "Этот run не владеет сессией. Требуется постоянный ID текущего участия.",
  runActorRequired: "Автор записи должен совпадать с агентом текущего активного участия.",
  activeRunMissing: "У сессии отсутствует активное участие.",
  creatorRunMissing: "Не найдено участие, создавшее дочернее поручение.",
  closedIntent: "Намерение уже закрыто. Создайте новое намерение для дальнейшей работы.",
  directChildRequired: "Можно принять только прямого ребёнка исходного намерения.",
  completedChildRequired: "Принимается только результат завершённого, не отменённого ребёнка.",
  openIntents: "Сначала закройте все намерения сессии.",
  unfinishedChild: "Сначала закройте дочернюю работу.",
  unacceptedChild: "Результат дочерней работы ещё не принят родителем.",
  sessionCycle: "Обнаружен цикл дочерних сессий.",

  /**
   * Указывает состояние, необходимое для подключения нового участия.
   */
  connectionStateRequired: (action: string, expected: string): string =>
    `Действие ${action} требует состояния ${expected}.`,
} as const;

/**
 * Диагностики повреждённых сохранённых данных истории.
 */
export const historyDataMessages = {
  /**
   * Называет повреждённую запись и поле без подмены неверных данных значением по умолчанию.
   */
  corruptField: (key: string, field: string): string => `Повреждена история ${key}: ${field}.`,
} as const;
