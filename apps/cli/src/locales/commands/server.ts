/**
 * Пользовательская справка и представление жизненного цикла Relay Server.
 */
export const serverCommandMessages = {
  group: {
    description: "Серверы REST API и Web для проекта или workspace",
    details:
      "start создаёт независимую пользовательскую native-службу; run удерживает сервер в текущем терминале. list/status проверяют защищённый health каждого экземпляра в RELAY_HOME. PID-файл не считается подтверждением работы. Из корня workspace сервер обслуживает все регистрации; --project выбирает одну. Обычные локальные команды Relay работают независимо от Server.",
    examples: [
      {
        description: "Запустить сервер workspace и открыть Web",
        command: "relay server start\nrelay server list\nrelay server open",
      },
    ],
  },
  start: {
    description: "Запустить новый независимый сервер в фоне",
    details:
      "Явно устанавливает и запускает user-systemd / LaunchAgent / Task Scheduler текущего пользователя. Служба переживает выход CLI и запускается при следующем входе пользователя до server stop. Linux linger и повышение прав не включаются. Требуется relay-server того же выпуска рядом с CLI, в PATH либо RELAY_SERVER_BIN. --port 0 (по умолчанию) выбирает свободный порт. --actor/RELAY_ACTOR задаёт автора Web по умолчанию; без них сохраняется автор web.",
    examples: [
      {
        description: "Запустить проект на свободном порту",
        command: "relay server start --actor human",
      },
      { description: "Задать порт workspace", command: "relay server start --port 8080" },
    ],
  },
  run: {
    description: "Удерживать сервер в текущем терминале",
    details:
      "Foreground связан с жизнью CLI через guardian и stdin-lease. Ctrl+C, SIGTERM и аварийный выход CLI завершают принадлежащие ему процессы. Подходит для контейнера и внешнего supervisor. Вывод сервера передаётся напрямую; отдельного итогового JSON нет.",
    examples: [{ description: "Запустить foreground", command: "relay server run --port 8080" }],
  },
  list: {
    description: "Показать все регистрации и число готовых серверов",
    details:
      "Работает без проекта и без установленного relay-server. running считает только совместимые ready health-ответы. stale означает оставшуюся запись без живого lease; unresponsive — занятый lease без подтверждённого health. Для каждого готового экземпляра показаны URL, PID, версия, область и все проекты с независимыми ошибками.",
    examples: [
      { description: "Получить машинный список", command: "relay server list --format json" },
    ],
  },
  status: {
    description: "Проверить health одного или всех серверов",
    details:
      "--instance принимает точный UUID из server list; без него проверяются все регистрации текущего RELAY_HOME. Версия и идентичность сверяются с защищённым loopback-ответом, а не только с PID.",
    examples: [
      {
        description: "Проверить сервер; замените UUID значением из list",
        command: "relay server status --instance 00000000-0000-0000-0000-000000000001",
      },
    ],
  },
  stop: {
    description: "Остановить выбранный сервер и убрать его автозапуск",
    details:
      "Требуется --instance UUID из list. Отправляет защищённый stop и останавливает принадлежащую этому UUID native-службу. Запись launch сохраняется для restart, данные проектов сохраняются. Чужой процесс не завершается по PID из реестра.",
    examples: [
      {
        description: "Остановить сервер; подставьте UUID",
        command: "relay server stop --instance 00000000-0000-0000-0000-000000000001",
      },
    ],
  },
  restart: {
    description: "Перезапустить сохранённую область выбранного сервера",
    details:
      "Сохраняет instance UUID, cwd/config/home/actor/port. Новый процесс получает новые bootId и секрет control. После foreground restart запускает native-службу. Совместимый binary проверяется до остановки старого процесса.",
    examples: [
      {
        description: "Перезапустить сервер; подставьте UUID",
        command: "relay server restart --instance 00000000-0000-0000-0000-000000000001",
      },
    ],
  },
  open: {
    description: "Открыть Web готового сервера в браузере",
    details:
      "Без --instance требуется ровно один ready сервер в текущем RELAY_HOME. При нескольких укажите UUID явно. Команда не создаёт дополнительный сервер.",
    examples: [
      { description: "Открыть единственный готовый сервер", command: "relay server open" },
    ],
  },
  home: "Корень реестра серверов; приоритет над RELAY_HOME",
  instance: "Точный UUID экземпляра из relay server list",
  port: "Порт HTTP 0–65535; 0 выбирает свободный порт",
  unknown: "неизвестно",
  projects: "Проекты",
  scope: "Область",
  version: "Версия",
  states: {
    ready: "готов",
    stopped: "остановлен",
    stale: "устаревшая запись",
    unresponsive: "нет health-ответа",
    incompatible: "несовместим",
    invalid: "повреждённая запись",
  },
  /**
   * Разделяет подтверждённую живость и число сохранённых записей.
   */
  counts: (running: number, registered: number): string =>
    `Готовых серверов: ${running}; регистраций: ${registered}`,
  /**
   * Не считает повторные workspace-имена одной БД независимыми доступными проектами.
   */
  projectCounts: (available: number, registrations: number): string =>
    `Доступных проектов: ${available}; регистраций проектов: ${registrations}`,
} as const;
