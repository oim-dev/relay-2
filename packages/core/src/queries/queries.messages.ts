/**
 * Сообщения поиска и диагностики целостности проекта.
 */
export const queryMessages = {
  searchFields: "Поиск принимает только поля q и kind",
  emptySearch: "Укажите непустой поисковый запрос",
  unknownSearchKind: "Неизвестный тип сущности",
  projectRecord: "Не найдена единственная запись проекта с ожидаемым ID",
  productRecord: "Ожидается единственный паспорт продукта",
  productBoard: "Ожидается единственная продуктовая доска",
  duplicateIds: "Обнаружены повторные ID сущностей",

  /**
   * Указывает место неверной формы сохранённой ссылки.
   */
  invalidReference: (path: string): string => `${path}: некорректная ссылка`,

  /**
   * Указывает отсутствующую цель ссылки в текущем снимке.
   */
  missingReference: (path: string, id: string): string => `${path}: отсутствует цель ${id}`,

  /**
   * Описывает несовместимость ожидаемого и сохранённого вида цели.
   */
  referenceKind: (path: string, id: string): string =>
    `${path}: тип ссылки не совпадает с типом цели ${id}`,

  /**
   * Указывает неверную форму коллекции ссылок.
   */
  referenceArray: (path: string): string => `${path}: ожидается массив ссылок`,

  /**
   * Указывает отсутствие обязательной скалярной ссылки.
   */
  requiredReference: (path: string): string => `${path}: отсутствует обязательная ссылка`,

  /**
   * Указывает неверную форму обязательной вложенной коллекции.
   */
  requiredArray: (path: string): string => `${path}: ожидается массив`,

  /**
   * Называет запись с неизвестным видом.
   */
  unknownEntityKind: (key: string): string => `${key}: неизвестный тип сущности`,

  /**
   * Называет ключ, назначенный более чем одной записи.
   */
  duplicateKey: (key: string): string => `Повторный ключ ${key}`,

  /**
   * Называет сущность с недопустимым форматом ключа.
   */
  invalidKey: (id: string): string => `${id}: недопустимый ключ`,

  /**
   * Называет запись с неверной ревизией содержания.
   */
  invalidRevision: (key: string): string => `${key}: недопустимая ревизия`,

  /**
   * Называет запись без обязательного авторства.
   */
  missingAuthor: (key: string): string => `${key}: отсутствует автор`,

  /**
   * Называет запись с неразбираемой датой создания или изменения.
   */
  invalidDate: (key: string): string => `${key}: недопустимая дата`,

  /**
   * Описывает нарушение обратной ссылки доски на приложение.
   */
  missingBoardBacklink: (key: string): string => `${key}: доска не ссылается на своё приложение`,

  /**
   * Описывает нарушение обратной ссылки приложения на доску.
   */
  missingApplicationBacklink: (key: string): string =>
    `${key}: приложение не ссылается на свою доску`,

  /**
   * Описывает ссылку сессии на отсутствующее участие.
   */
  missingCurrentRun: (key: string): string => `${key}: текущее участие отсутствует в сессии`,

  /**
   * Описывает контрольную точку с отсутствующим участием её сессии.
   */
  missingCheckpointRun: (key: string): string =>
    `${key}: участие контрольной точки отсутствует в её сессии`,

  /**
   * Добавляет ключ карточки к предметной ошибке декодирования.
   */
  invalidRecord: (key: string, message: string): string => `${key}: ${message}`,

  /**
   * Сохраняет предметный код ошибки общего графа в диагностике doctor.
   */
  invalidTaskGraph: (code: string, message: string): string => `${code}: ${message}`,

  /**
   * Формирует итоговую ошибку целостности из диагностик одного снимка.
   */
  integrityError: (issues: readonly string[]): string =>
    `Обнаружены нарушения: ${issues.join("; ")}`,
} as const;
