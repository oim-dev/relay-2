/**
 * Диагностики изменения локального реестра проектов.
 */
export const workspaceMessages = {
  invalidRegistrationName: "Имя регистрации не должно быть пустым или содержать пробелы по краям",
  emptyProjectPath: "Путь проекта не должен быть пустым",

  /**
   * Описывает отсутствие workspace над рабочим каталогом.
   */
  workspaceNotFound: (cwd: string): string => `Workspace не найден: ${cwd}`,

  /**
   * Объясняет отказ зарегистрировать workspace как самостоятельный проект.
   */
  cannotRegisterWorkspace: (path: string): string =>
    `Нельзя зарегистрировать workspace вместо проекта: ${path}`,

  /**
   * Указывает имя регистрации, уже связанное с другим конфигом.
   */
  registrationExists: (name: string): string => `Имя проекта уже зарегистрировано: ${name}`,
} as const;
