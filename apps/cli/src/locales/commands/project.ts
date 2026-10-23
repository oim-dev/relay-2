/**
 * Русские тексты команд локального проекта и реестра workspace.
 */
export const projectCommandMessages = {
  init: {
    description: "Создать локальный проект и SQLite-базу",
    details:
      "Создаёт relay.config.json в текущем каталоге и отдельную базу в RELAY_HOME/projects/<ID>/project.sqlite; без RELAY_HOME используется ~/.relay. Конфиг сохраняет version и projectId. Создаются паспорт проекта и доска продукта. Начальные записи создаются от system независимо от --actor и RELAY_ACTOR; автор для init не требуется.\n\nПовторная инициализация не заменяет существующие данные. --config выбирает другое расположение конфига. Имя по умолчанию берётся из каталога; slug можно задать явно. После создания прочитайте relay project get, затем добавьте документ или паспорт продукта через product create.",
    examples: [
      {
        description: "Создать проект",
        command: "relay init --name 'Библиотека инструкций' --slug instructions",
      },
    ],
  },
  projectName: "Человекочитаемое имя проекта; по умолчанию — имя текущего каталога",
  projectSlug: "Короткое имя: строчные латинские буквы, цифры и дефисы",
  config: {
    description: "Локальная конфигурация",
    details:
      "Конфигурация связывает каталог с постоянным ID проекта. В workspace выберите регистрацию через --project. config get показывает исходный JSON и вычисленное расположение базы.",
    examples: [{ description: "Проверить выбранный проект и пути", command: "relay config get" }],
  },
  configGet: {
    description: "Прочитать конфигурацию выбранного проекта",
    details:
      "Возвращает исходный конфиг в data и вычисленные пути в meta. Без databasePath база выбирается внутри текущего RELAY_HOME (по умолчанию ~/.relay). Явный databasePath имеет приоритет; относительный путь определяется физическим каталогом конфига.\n\nВ workspace обязателен --project: команда читает конфиг выбранного проекта. Наличие и идентичность базы проверяются; отсутствующая база не создаётся. Список регистраций доступен через workspace project list.",
    examples: [
      { description: "Прочитать конфигурацию текущего проекта", command: "relay config get" },
      {
        description: "Прочитать конфигурацию регистрации workspace",
        command: "relay config get --project backend",
      },
    ],
  },
  workspace: {
    description: "Набор независимых локальных проектов",
    details:
      "Workspace хранит имена регистраций и пути каталогов проектов в relay.workspace.json. Создайте реестр через workspace project init, зарегистрируйте уже инициализированные проекты через add и выбирайте их параметром --project.",
    examples: [{ description: "Посмотреть регистрации", command: "relay workspace project list" }],
  },
  workspaceProject: {
    description: "Регистрации проектов workspace",
    details:
      "Каждая регистрация содержит имя и каталог с собственным relay.config.json. Данные проектов независимы. Для предметной команды в workspace обязателен явный --project; удаление регистрации сохраняет конфиг и базу проекта.",
    examples: [
      {
        description: "Зарегистрировать подготовленный проект",
        command: "relay workspace project add backend ../backend",
      },
      { description: "Открыть выбранный проект", command: "relay project get --project backend" },
    ],
  },
  workspaceInit: {
    description: "Создать пустой локальный workspace",
    details:
      "Создаёт relay.workspace.json в текущем каталоге или файл, выбранный через --config. Существующий конфиг не заменяется. Проекты добавляются отдельно: workspace project add <имя> <каталог>. workspace init — сокращённый вариант workspace project init.",
    examples: [
      { description: "Создать реестр проектов", command: "relay workspace project init" },
      { description: "Создать реестр сокращённой командой", command: "relay workspace init" },
    ],
  },
  projectList: {
    description: "Список зарегистрированных проектов",
    details:
      "Возвращает страницу регистраций с абсолютными путями каталогов. Список доступен и при недоступных базах зарегистрированных проектов. Для продолжения используйте nextCommand; после изменения реестра начните список заново. Предметная карточка проекта читается через project get --project <имя>.",
    examples: [
      {
        description: "Прочитать страницу регистраций",
        command: "relay workspace project list --limit 20",
      },
    ],
  },
  projectAdd: {
    description: "Зарегистрировать существующий локальный проект",
    details:
      "Аргументы по порядку: имя регистрации и каталог проекта. В каталоге обязателен relay.config.json; база проверяется с текущим RELAY_HOME. Относительный аргумент пути определяется каталогом запуска. Повтор того же имени и пути ничего не меняет; другое расположение под занятым именем отклоняется.",
    examples: [
      {
        description: "Добавить соседний проект",
        command: "relay workspace project add backend ../backend",
      },
    ],
  },
  projectRemove: {
    description: "Удалить регистрацию проекта",
    details:
      "Удаляет только запись из workspace: каталог, конфигурация и база проекта сохраняются. Операция доступна при недоступной базе. Если имени уже нет, возвращает removed: false. Остальные регистрации читаются через workspace project list.",
    examples: [
      {
        description: "Убрать проект из реестра",
        command: "relay workspace project remove backend",
      },
    ],
  },
  registrationName: "Имя регистрации workspace, используемое в --project",
  registrationPath: "Каталог существующего проекта с relay.config.json в корне",
} as const;
