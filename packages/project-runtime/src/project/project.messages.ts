import { ENTITY_SLUG_LENGTH, PROJECT_NAME_LENGTH } from "@relay/contracts";

/**
 * Диагностики создания и выбора локального проекта.
 */
export const projectMessages = {
  defaultName: "Проект",
  emptyName: "Название проекта не должно быть пустым",
  invalidName: `Название проекта: ${PROJECT_NAME_LENGTH.min}–${PROJECT_NAME_LENGTH.max} символов однострочного текста без управляющих символов`,
  invalidSlug: `Slug проекта: ${ENTITY_SLUG_LENGTH.min}–${ENTITY_SLUG_LENGTH.max} строчные латинские буквы/цифры с одиночными дефисами между частями`,
  workspaceRequired: "Выбор --project требует конфигурацию workspace",
  projectRequired: "Выберите проект workspace через --project",

  /**
   * Указывает конфигурацию, постоянный ID которой не совпал с открытой базой.
   */
  projectIdMismatch: (path: string): string =>
    `ID проекта в конфигурации и базе не совпадают: ${path}`,

  /**
   * Описывает отсутствие конфигурации проекта над рабочим каталогом.
   */
  projectNotFound: (cwd: string): string => `Проект не найден: ${cwd}`,

  /**
   * Указывает имя, отсутствующее в выбранном workspace.
   */
  registrationNotFound: (name: string): string => `Проект не зарегистрирован в workspace: ${name}`,

  /**
   * Указывает регистрацию, ссылающуюся на workspace вместо проекта.
   */
  registrationRequiresProject: (path: string): string =>
    `Регистрация должна ссылаться на проект: ${path}`,
} as const;
