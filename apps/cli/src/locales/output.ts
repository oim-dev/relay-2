/**
 * Подписи предметных полей в полном текстовом представлении CLI.
 * Неизвестное поле сохраняет своё машинное имя.
 */
export const outputLabels: Readonly<Record<string, string>> = {
  id: "ID",
  kind: "Тип",
  key: "Ключ",
  revision: "Ревизия",
  name: "Название",
  title: "Заголовок",
  slug: "Slug",
  summary: "Аннотация",
  description: "Описание",
  body: "Содержание",
  status: "Состояние",
  column: "Колонка",
  goal: "Цель",
  result: "Результат",
  reason: "Причина",
  createdAt: "Создано",
  updatedAt: "Изменено",
  createdBy: "Автор создания",
  updatedBy: "Автор изменения",
  completed: "Выполнено",
  canComplete: "Можно завершить",
  blockers: "Блокеры",
  items: "Записи",
  projectId: "ID проекта",
  databasePath: "База данных",
  configPath: "Конфигурация",
  generation: "Поколение",
  criteria: "Критерии",
  comments: "Комментарии",
  stages: "Этапы",
  taskIds: "Задачи",
  targets: "Цели",
  parentId: "Родитель",
  dependencies: "Зависимости",
  sections: "Разделы",
  documentSections: "Разделы документов",
  links: "Связи",
  relations: "Отношения",
  participants: "Участники",
  scope: "Область",
  outcome: "Итог",
  expectedResult: "Ожидаемый результат",
  completionConditions: "Условия завершения",
  boundaries: "Границы",
  rationale: "Обоснование",
  runId: "ID участия",
  currentRunId: "Текущее участие",
  nextStep: "Следующий шаг",
  remaining: "Осталось",
  done: "Сделано",
  checks: "Проверки",
  valid: "Проверка пройдена",
  issues: "Обнаруженные проблемы",
  total: "Всего",
  acceptanceCriteria: "Критерии приёмки",
  boardId: "ID доски",
  applicationId: "ID приложения",
  featureId: "ID фичи",
  scenarioId: "ID сценария",
  targetId: "ID цели",
  implementationIds: "ID реализаций",
  related: "Связанные задачи",
  documentKind: "Вид документа",
  documentStatus: "Состояние документа",
  sectionId: "ID раздела",
  pinned: "Закреплён",
  plan: "План",
  stage: "Этап",
  task: "Задача",
  session: "Сессия",
  checkpoint: "Контрольная точка",
  planIds: "ID планов",
  parentSessionId: "Родительская сессия",
  sessionId: "ID сессии",
  intentId: "ID намерения",
  runs: "Участия",
  operator: "Пользователь",
  children: "Дочерние поручения",
  intents: "Открытые намерения",
  references: "Ссылки",
  counts: "Счётчики",
  columns: "Колонки",
  completedAt: "Время выполнения",
  completedBy: "Автор выполнения",
  blocked: "Заблокировано",
  records: "Записей",
  bytes: "Размер в байтах",
};

/**
 * Тексты и шаблоны представления результатов, не затрагивающие JSON-значения.
 */
export const outputMessages = {
  missing: "—",
  yes: "да",
  no: "нет",
  completed: "выполнено",
  unfinished: "не выполнено",
  emptyPage: "Записей нет.",

  /**
   * Форматирует поле, начиная многострочное значение с отдельной строки.
   */
  field: (label: string, text: string): string =>
    `${label}:${text.includes("\n") ? "\n" : " "}${text}`,

  /**
   * Форматирует элемент вложенного состава без изменения его содержания.
   */
  listItem: (text: string): string => `- ${text}`,

  /**
   * Собирает краткое представление сущности с ревизией и необязательным состоянием.
   */
  entity: (key: string, title: string, revision: string, state: string | undefined): string =>
    `${key} · ${title} · ревизия ${revision}${state === undefined ? "" : ` · ${state}`}`,

  /**
   * Объединяет известные поля краткой записи в прежнем порядке.
   */
  summary: (parts: readonly unknown[]): string => parts.join(" · "),

  /**
   * Показывает фактическое число записей окна и полный размер списка.
   */
  pageCount: (count: number, total: number): string => `Показано ${count} из ${total}.`,

  /**
   * Подписывает готовую команду продолжения списка.
   */
  continuation: (command: string): string => `Продолжение: ${command}`,
} as const;
