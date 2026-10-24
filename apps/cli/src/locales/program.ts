/**
 * Описания корневой программы и глобальных параметров CLI.
 */
export const programMessages = {
  header: "Relay — рабочая память проекта для людей и AI-агентов",
  help: {
    description: "Рабочая память проекта для людей и AI-агентов",
    details:
      "Сохраняйте знания в product, feature, scenario и document; описывайте приложения через application и implementation. Работу ведите в task и plan, выпуск фиксируйте в release, намерения и результаты — в session и checkpoint. overview показывает сводку, search находит записи, get читает выбранный набор целиком (--summary — кратко), batch применяет атомарный пакет изменений.\n\nЗапускайте relay из корня проекта с relay.config.json или workspace с relay.workspace.json. В workspace выбирайте --project <имя>; регистрации доступны через workspace project list. Родительские каталоги не проверяются.\n\nСоздание и изменение предметных записей требует --actor или RELAY_ACTOR. Перед изменением прочитайте запись через get и передайте её revision в --if-revision; для вложенных данных владельца ревизии указывает справка команды. При конфликте перечитайте и согласуйте изменения.\n\nГруппа без подкоманды показывает справку. relay <команда> --help объясняет параметры, правила и примеры без открытия проекта. <аргумент> обязателен, [аргумент] необязателен. Текстовые поля принимают --поле либо --поле-file <путь|->; «-» читает stdin. Один источник на поле и один потребитель stdin. Одиночные предметные команды принимают --input/--input-file вместо отдельных полей. У batch единственный источник --input: JSON, @путь или «-».\n\nРезультат выводится в stdout, диагностика — в stderr. Частичный get сохраняет найденные и ошибочные элементы в stdout с ненулевым кодом завершения. Коды: 0 — успех, 2 — неверный ввод, 3 — запись не найдена, 4 — конфликт. --format json предназначен для скриптов; справка и версия всегда текстовые.",
    examples: [
      {
        description: "Создать проект в текущем каталоге",
        command: "relay init --name 'Мой проект' --slug my-project",
      },
      {
        description: "Сохранить первый документ",
        command:
          "relay document create --name 'Договорённости' --body 'Все изменения проходят ревью.' --actor human",
      },
      {
        description: "Найти незавершённые задачи",
        command: "relay task list --completion unfinished",
      },
      { description: "Изучить создание задачи", command: "relay task create --help" },
    ],
  },
  config: "Файл проекта или workspace; приоритет над RELAY_CONFIG",
  project: "Имя регистрации из workspace project list",
  actor: "Автор предметной записи (обязателен для записи); иначе RELAY_ACTOR",
  expectedAddresses:
    "Привязки адресов для предметных команд и batch: JSON-массив {ref, expectedId}; проверяются Core при записи",
  format: "Вывод: text для чтения, json для скриптов",
} as const;
