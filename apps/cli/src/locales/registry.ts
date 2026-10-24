/**
 * Диагностики регистрации, выбора проекта и синтаксиса команд.
 */
export const registryMessages = {
  actorRequired: "Для записи укажите --actor или RELAY_ACTOR",
  emptyCommandPath: "Путь регистрируемой команды пуст",
  writePreconditionHelp:
    "Предусловие записи: передайте --if-revision либо --expected-version. Можно передать оба, тогда Core проверит оба, включая no-op. Переносимый токен берите для указанного в описании владельца через relay get ID-владельца --summary --with-versions --format json: поле meta.versions[ID].aggregateVersion. Токен передаётся дословно; локальная revision и переносимая версия — самостоятельные предусловия.",
  createVersionHelp:
    "--expected-version позволяет проверить переносимую версию существующего владельца этой операции. Получите его через relay get ID-владельца --summary --with-versions --format json и передайте meta.versions[ID].aggregateVersion дословно.",

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
