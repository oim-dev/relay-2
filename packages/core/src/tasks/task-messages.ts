/**
 * Предметные подписи полей и операций на границе ввода задач.
 */
export const taskLabels = {
  task: "Задача",
  board: "Доска",
  parent: "Родитель",
  dependencies: "Зависимости",
  related: "Связанные задачи",
  linkedTask: "Связанная задача",
  targets: "Цели реализации",
  target: "Цель",
  implementationTarget: "Цель реализации",
  title: "Заголовок задачи",
  description: "Описание задачи",
  criteria: "Критерии",
  criterion: "Критерий",
  criterionId: "ID критерия",
  criterionTitle: "Заголовок критерия",
  criterionSummary: "Краткое описание критерия",
  criterionDescription: "Описание критерия",
  criterionAction: "Операция с критерием",
  criterionChange: "Изменение критерия",
  commentBody: "Комментарий",
  commentTitle: "Заголовок комментария",
  commentId: "ID комментария",
  creation: "Создание задачи",
  update: "Обновление задачи",
  move: "Перенос задачи",
  filters: "Фильтры задач",
  completion: "Завершённость",
  searchIn: "Область поиска",
  search: "Поиск",
  readiness: "Готовность",
  writeOptions: "Параметры записи",
} as const;

/**
 * Подписи текстов критерия по предметному имени поля для общего правила проверки.
 */
export const taskCriterionLabels = {
  title: taskLabels.criterionTitle,
  summary: taskLabels.criterionSummary,
  description: taskLabels.criterionDescription,
} as const;

/**
 * Диагностики проверки ввода, ссылок и обязательств задач.
 */
export const taskMessages = {
  emptyUpdate: "Передайте хотя бы одно поле задачи",
  emptyMove: "Передайте доску или колонку",
  parentAliases: "Передайте только parent или parentId",
  targetAliases: "Передайте только target или productTarget",
  criterionAliases: "Передайте только id или criterionId",
  emptyCriterionUpdate: "Передайте хотя бы одно текстовое поле критерия",
  taskDone: "Сначала верните задачу из done в работу",
  criterionNotFound: "Критерий не найден",
  commentNotFound: "Комментарий не найден",
  taskNotFound: "Задача не найдена",
  revisionRequired: "Нужна положительная целая ifRevision",
  revisionConflict: "Задача изменена: перечитайте её перед записью",
  duplicateTargets: "Цели реализации не должны повторяться",
  applicationTargets: "На доске приложения допустимы только реализации собственного приложения",
  inactiveTarget: "Снятая реализация не допускает нового назначения",
  productTargets: "На продуктовой доске допустимы только фичи и сценарии",
  unsupportedBoardTargets: "Эта доска не допускает целей реализации",
  targetKind: "Нужна фича, сценарий или реализация",
  incomplete: "Завершение требует выполнения критериев, детей и зависимостей",
  completedParent: "Для добавления невыполненного ребёнка верните родителя из done в работу",
  removeBoolean: "remove должен быть логическим значением",
  selfReference: "Самоссылка задачи запрещена",
  brokenObligation: "В графе задач отсутствует обязательная задача",
  cycle: "Обнаружен цикл родительства и обязательных зависимостей",

  /**
   * Описывает неверную форму объекта команды.
   */
  expectedObject(label: string): string {
    return `${label}: ожидается объект`;
  },

  /**
   * Описывает объект с недопустимым прототипом.
   */
  expectedPlainObject(label: string): string {
    return `${label}: ожидается обычный объект полей`;
  },

  /**
   * Называет неизвестное поле команды.
   */
  unknownField(label: string, field: string): string {
    return `${label}: неизвестное поле ${field}`;
  },

  /**
   * Отличает явно переданный undefined от отсутствующего поля.
   */
  undefinedField(label: string, field: string): string {
    return `${label}: поле ${field} не может быть undefined`;
  },

  /**
   * Сообщает о недопустимом обнулении поля.
   */
  nullField(label: string, field: string): string {
    return `${label}: поле ${field} не может быть null`;
  },

  /**
   * Указывает ограничение длины и формы строки.
   */
  invalidText(name: string, maximum: number): string {
    return `${name}: ожидается строка длиной не более ${maximum} символов без NUL`;
  },

  /**
   * Сообщает о переносах строк в однострочном поле.
   */
  singleLine(name: string): string {
    return `${name}: нужна одна строка`;
  },

  /**
   * Сообщает о пустом обязательном тексте.
   */
  requiredText(name: string): string {
    return `${name}: пустое значение недопустимо`;
  },

  /**
   * Описывает недопустимые символы пользовательской ссылки.
   */
  invalidReference(name: string): string {
    return `${name}: пробелы по краям и управляющие символы недопустимы`;
  },

  /**
   * Перечисляет допустимые колонки задачи.
   */
  unknownColumn(columns: readonly string[]): string {
    return `Неизвестная колонка; допустимы ${columns.join(", ")}`;
  },

  /**
   * Перечисляет допустимые значения поля.
   */
  invalidChoice(name: string, variants: readonly string[]): string {
    return `${name}: допустимы ${variants.join(", ")}`;
  },

  /**
   * Указывает ограничение числа элементов входного массива.
   */
  invalidArray(name: string, maximum: number): string {
    return `${name}: ожидается массив длиной не более ${maximum}`;
  },

  /**
   * Сообщает о нескольких ссылках на одну задачу в одном списке.
   */
  duplicateTasks(name: string): string {
    return `${name}: повторяющиеся задачи недопустимы`;
  },

  /**
   * Называет предел критериев одной задачи.
   */
  criteriaLimit(maximum: number): string {
    return `В задаче допускается не более ${maximum} критериев`;
  },

  /**
   * Называет предел связей одного вида.
   */
  linksLimit(maximum: number): string {
    return `В задаче допускается не более ${maximum} связей каждого вида`;
  },

  /**
   * Идентифицирует повреждённую сохранённую карточку или графовую проекцию.
   */
  corruptTask(key: string): string {
    return `Повреждена задача ${key}`;
  },
} as const;
