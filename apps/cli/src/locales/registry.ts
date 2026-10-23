/**
 * Диагностики регистрации, выбора проекта и синтаксиса команд.
 */
export const registryMessages = {
  actorRequired: "Для записи укажите --actor или RELAY_ACTOR",
  emptyCommandPath: "Путь регистрируемой команды пуст",

  /**
   * Указывает путь, для которого уже зарегистрирован обработчик.
   */
  duplicateRegistration: (path: string): string => `Повторная регистрация: ${path}`,

  /**
   * Указывает неизвестный сегмент после пути команды без позиционных аргументов.
   */
  unknownCommand: (value: string): string => `Неизвестная команда: «${value}»`,

  /**
   * Указывает позиционный аргумент сверх объявленной схемы.
   */
  extraArgument: (value: string): string => `Лишний аргумент: «${value}»`,
} as const;
