/**
 * Диагностики локального жизненного цикла серверов.
 */
export const serverMessages = {
  invalid: "Повреждена или несовместима запись реестра Relay Server",
  noConfig: "Для запуска сервера выберите проект или workspace через cwd либо --config",
  ambiguousProject: "Один projectId соответствует разным физическим базам workspace",
  binaryMissing: "Не найден relay-server: соберите компонент или укажите RELAY_SERVER_BIN",
  versionMismatch: "Версия relay-server не совпадает с версией CLI",
  notReady: "Сервер не подтвердил готовность; проверьте статус и журнал native-службы",
  notFound: "Экземпляр Relay Server не найден в выбранном RELAY_HOME",
  ownership: "Служебная конфигурация не принадлежит выбранному Relay Server",
  managerFailed: "Не удалось выполнить действие native-службы Relay Server",
  unsupported:
    "Фоновый запуск поддержан только через systemd --user, LaunchAgent или Task Scheduler",
  invalidInput: "Некорректные параметры запуска Relay Server",
  invalidUrl: "URL готового Relay Server должен указывать на корень http://127.0.0.1:<port>/",
  launchChanged: "Параметры регистрации изменились во время запуска Relay Server",
  noReady: "Нет готового сервера для открытия; сначала выполните relay server start",
  ambiguous: "Запущено несколько серверов; выберите точный --instance из relay server list",
  stopTimeout: "Сервер не завершил остановку в отведённое время; чужие PID не затронуты",
  cancelled: "Операция управления Relay Server отменена",
  processFailed: "Foreground Relay Server завершился с ошибкой",
  closed: "Регистрация Relay Server уже закрыта или опубликована",
  incompatible: "Health не подтвердил идентичность и совместимую версию сервера",
} as const;
