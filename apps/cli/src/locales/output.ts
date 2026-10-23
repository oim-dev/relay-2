import type { EntityKind } from "@relay/contracts";

/**
 * Подписи предметных полей в полном текстовом представлении CLI.
 * Неизвестное поле сохраняет своё машинное имя.
 */
export const outputLabels = {
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
  plans: "Планы",
  release: "Релиз",
  plannedFor: "Плановая дата",
  releasedAt: "Время выпуска",
  releasedBy: "Автор выпуска",
  canRelease: "Можно выпустить",
  percent: "Процент",
  stage: "Этап",
  task: "Задача",
  session: "Сессия",
  checkpoint: "Контрольная точка",
  planIds: "ID планов",
  parentSessionId: "Родительская сессия",
  sessionId: "ID сессии",
  sessionRevision: "Ревизия сессии при записи",
  acceptedSessionIds: "Принятые дочерние сессии (ID)",
  sequence: "Порядковый номер в сессии",
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
  operationKey: "Ключ операции",
  replayed: "Повторное чтение квитанции",
  index: "Индекс операции",
  op: "Операция",
  as: "Локальное имя",
  entities: "Итоговые сущности",
  owner: "Владелец ревизии",
  outputs: "Дополнительные результаты",
} as const;

/**
 * Уточнения одинаковых имён полей по виду записи, не меняющие подписи других DTO.
 */
export const outputEntityLabels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  release: { version: "Версия выпуска" },
  "work-checkpoint": { revision: "Ревизия контрольной точки" },
};

/**
 * Подписи исходной конфигурации, отличающие сохранённое переопределение от вычисленного пути.
 */
export const configurationLabels: Readonly<Record<string, string>> = {
  ...outputLabels,
  version: "Версия конфигурации",
  databasePath: "Путь базы в конфиге (переопределение)",
};

/**
 * Названия глобальных счётчиков записей в компактной сводке проекта.
 */
export const overviewKindLabels: Readonly<Record<EntityKind, string>> = {
  project: "Проекты",
  product: "Продукты",
  feature: "Фичи",
  scenario: "Сценарии",
  application: "Приложения",
  implementation: "Реализации",
  board: "Доски",
  document: "Документы",
  task: "Задачи",
  "work-plan": "Планы",
  release: "Релизы",
  "work-session": "Сессии",
  "work-checkpoint": "Контрольные точки",
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
  inactiveImplementation: "участие снято",
  comment: "Комментарий",
  commentAuthor: "Автор",
  sessionRoot: "корень",
  configurationSource: "Исходная конфигурация",
  configurationLocation: "Вычисленное расположение",
  overviewSummary: "Сводка проекта",

  /**
   * Отделяет полное тело комментария от метаданных, не меняя его пробелы и переводы строк.
   */
  commentBody: (body: string): string => `Содержание:\n${body}`,

  /**
   * Подписывает родительскую сессию, чей ключ присутствует на этой же странице.
   */
  sessionParent: (key: string): string => `  Родительская сессия: ${key}`,

  /**
   * Сохраняет адрес родителя за пределами окна, не выдавая дочернюю сессию за корень.
   */
  sessionParentOutsidePage: (id: string): string =>
    `  Родительская сессия (ID, вне страницы): ${id}`,

  /**
   * Дополняет краткую карточку проекта поколением общего снимка.
   */
  overviewProject: (summary: string, generation: number): string =>
    `${summary} · поколение ${generation}`,

  /**
   * Показывает размер всего проекта, а не текущего окна карты.
   */
  overviewRecords: (total: number): string => `Записей: ${total}`,

  /**
   * Показывает один счётчик вида записи либо колонки задач.
   */
  overviewCount: (label: string, count: number): string => `${label} ${count}`,

  /**
   * Отделяет глобальную сводку задач от общего каталога записей.
   */
  overviewTasks: (total: number, columns: string): string => `Задачи (${total}): ${columns}`,

  /**
   * Уточняет предметный смысл блокировок в обзоре проекта.
   */
  overviewBlocked: (count: number): string => `С незавершёнными прямыми обязательствами: ${count}`,

  /**
   * Отмечает размер текущего окна рядом с заголовком карты.
   */
  overviewMap: (count: number, total: number): string => `Карта — ${count} из ${total}`,

  /**
   * Добавляет вид записи к её адресу в смешанной карте проекта.
   */
  mapKey: (key: string, kind: string): string => `${key} [${kind}]`,

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
