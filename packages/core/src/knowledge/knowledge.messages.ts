import { ENTITY_SLUG_LENGTH, PROJECT_NAME_LENGTH } from "@relay/contracts";

/**
 * Диагностики входа, предметных ограничений и повреждения знаний.
 */
export const knowledgeMessages = {
  inputLabel: "Ввод",
  filtersLabel: "Фильтры",
  writeLabel: "Параметры записи",
  relationLabel: "Отношение",
  relationTargetLabel: "Цель отношения",
  /**
   * Описывает требование объектной формы на внешней границе.
   */
  object: (label: string): string => `${label}: требуется объект`,
  /**
   * Описывает запрет экземпляров классов во входных данных.
   */
  plainObject: (label: string): string => `${label}: требуется обычный объект`,
  /**
   * Указывает неизвестное или защищённое от изменения поле.
   */
  field: (label: string, key: string): string =>
    `${label}: неизвестное или неизменяемое поле ${key}`,
  /**
   * Описывает требование строки с учётом допустимости пустого текста.
   */
  text: (label: string, nonempty: boolean): string =>
    `${label}: требуется ${nonempty ? "непустая " : ""}строка`,
  /**
   * Описывает запрет многострочного названия.
   */
  name: (label: string): string => `${label}: название должно занимать одну строку`,
  /**
   * Перечисляет допустимые значения предметного поля.
   */
  choice: (label: string, values: readonly string[]): string =>
    `${label}: допустимы ${values.join(", ")}`,
  /**
   * Описывает требование логического значения без строкового преобразования.
   */
  boolean: (label: string): string => `${label}: требуется boolean`,
  /**
   * Описывает конфликт альтернативных имён входного поля.
   */
  alias: (first: string, second: string): string =>
    `Укажите только одно из полей ${first}, ${second}`,
  /**
   * Описывает конфликт ревизии изменяемой записи.
   */
  revision: (key: string): string =>
    `Изменилась ревизия ${key}; перечитайте запись и согласуйте изменение`,
  /**
   * Описывает обязательную ссылку для несинглтонного вида.
   */
  reference: (kind: string): string => `Для ${kind} требуется ref`,
  /**
   * Указывает повреждённое поле сохранённой записи.
   */
  corrupt: (key: string, field: string): string => `Повреждены данные ${key}: ${field}.`,
  /**
   * Описывает ссылку документа на незарегистрированный раздел.
   */
  unknownSection: (key: string): string => `Раздел документа ${key} не зарегистрирован в проекте.`,
  /**
   * Описывает отсутствие активного раздела.
   */
  sectionNotFound: (id: string): string => `Раздел ${id} не найден`,
  /**
   * Описывает пожизненно зарезервированный ID раздела.
   */
  sectionExists: (id: string): string => `ID раздела ${id} уже использован`,
  projectName: `Название проекта: ${PROJECT_NAME_LENGTH.min}–${PROJECT_NAME_LENGTH.max} символов однострочного текста без управляющих символов`,
  slug: `slug: ${ENTITY_SLUG_LENGTH.min}–${ENTITY_SLUG_LENGTH.max} строчные латинские буквы/цифры с одиночными дефисами между частями`,
  prefix: "prefix: заглавные латинские буквы, цифры и одиночные дефисы, до 32 символов",
  revisionRequired: "ifRevision: требуется положительная целая ревизия",
  targetRequired: "target: требуется фича или сценарий",
  sortMismatch: "sort фильтра не совпадает с порядком окна",
  projectCreation: "Проект создаётся при инициализации базы",
  boardCreation: "Доски создаются только вместе с проектом или приложением",
  productExists: "Паспорт уже заполнен; используйте update с его ревизией",
  participationExists:
    "Участие в этой цели уже существует; снятое участие возвращается через replaceParticipation",
  boardUpdate: "Имя доски приложения меняется через application update",
  emptyUpdate: "Укажите хотя бы одно изменяемое поле",
  foreignBoard: "Доска не принадлежит приложению",
  sectionId: "id раздела: до 64 латинских букв, цифр, дефисов и подчёркиваний",
  sectionLimit: "Допускается не более 100 разделов",
  sectionPosition: "Укажите before (null — в конец) либо last: true",
  sectionSelfMove: "Нельзя переместить раздел перед самим собой",
  unlinkDescription: "Открепление не принимает description",
  relationLimit: "Допускается не более 100 отношений документа",
  targetsArray: "targets: требуется массив ссылок",
  foreignImplementation: "Реализация принадлежит другому приложению",
  participationTarget: "Состав принимает фичи, сценарии или реализации этого приложения",
  duplicateParticipation: "В составе повторяется одна и та же цель",
  missingSelectedFeature: "SI требует FI своей фичи в выбранном составе",
  relationAliases: "Укажите relations либо targets",
  relationsArray: "relations/targets: требуется массив",
  duplicateRelation: "Повторяется пара цель + тип отношения",
  relationTarget: "Этот вид сущности не поддерживает прикрепление документа",
  relationSelf: "Документ не может ссылаться на себя",
  inactiveRelation: "Новое прикрепление к снятой реализации недопустимо",
  boardAddress: "Slug или префикс доски уже занят",
  missingActiveFeature: "SI требует активную FI той же фичи в том же приложении",
} as const;
