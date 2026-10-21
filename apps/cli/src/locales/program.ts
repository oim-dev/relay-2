/**
 * Описания корневой программы и глобальных параметров CLI.
 */
export const programMessages = {
  description: "Рабочая память проекта для людей и AI-агентов",
  header: "Relay — рабочая память проекта для людей и AI-агентов",
  examples: "relay init --name 'Мой проект'\nrelay task list\nrelay --help\nrelay --version",
  config: "Путь к конфигурации проекта или workspace",
  project: "Имя регистрации workspace",
  actor: "Автор записи; иначе RELAY_ACTOR",
  format: "Вывод: text для чтения, json для скриптов",
} as const;
