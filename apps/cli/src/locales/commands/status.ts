/**
 * Справка и текстовая сводка локального окружения Relay.
 */
export const statusCommandMessages = {
  command: {
    description: "Показать общее состояние Relay в текущем RELAY_HOME",
    details:
      "Перечисляет все локальные проекты home и серверы, путь CLI, окружение и известные конфиги. Не требует проекта. Ближайший конфиг в cwd или его родителях используется только для подсветки; --config/--project не фильтруют общий список. Базы читаются readonly без миграций и Git-обмена. Конфиги известны из текущего контекста и запусков Server; полный поиск checkout по диску не выполняется.",
    examples: [
      { description: "Получить общую сводку", command: "relay status" },
      {
        description: "Проверить отдельный home в JSON",
        command: "relay status --home /путь/к/.relay-home --format json",
      },
    ],
  },
  home: "Корень состояния Relay; приоритет над RELAY_HOME",
  cli: "CLI",
  executable: "Исполняемый файл",
  version: "Версия",
  cwd: "Текущий каталог",
  projects: "Проекты",
  servers: "Серверы",
  configurations: "Известные конфиги",
  environment: "Окружение Relay",
  currentConfig: "Текущий конфиг",
  database: "База",
  synchronization: "Git Sync",
  current: "текущий",
  unavailable: "недоступен",
  available: "доступен",
  unknown: "неизвестно",
  none: "нет",
  auto: "автоматический",
  manual: "ручной",
} as const;
