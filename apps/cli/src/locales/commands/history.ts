/**
 * Русские тексты команд поручений, участия и контрольных точек.
 */
export const historyCommandMessages = {
  session: {
    description: "История поручений и участия агентов",
    details:
      "Сессия хранит поручение, состояние, участия (runs), дочерние поручения и итог. start создаёт корневую сессию с активным участием; checkpoint open фиксирует намерение. Дочернее поручение создаётся из намерения через session fork и принимается исполнителем через attach.\n\nПеред записью читайте session get: нужны revision сессии и currentRunId активного участия. Для действий владельца --actor должен совпадать с автором run. Материалы читаются через session history/context и checkpoint get. После потери ответа сначала перечитайте состояние: повтор может создать новую запись.",
    examples: [
      { description: "Найти незавершённые поручения", command: "relay session list --unfinished" },
      { description: "Прочитать состояние и участие", command: "relay session get S-session" },
    ],
  },
  list: {
    description: "Прочитать страницу поручений",
    details:
      "--unfinished выбирает pending/open/paused. --status принимает pending, open, paused, completed, cancelled. --parent <ссылка> ограничивает прямых детей; --parent null — только корневые сессии. --actor-filter выбирает автора участия, --q ищет по содержанию.\n\nПоследние изменённые записи идут первыми. Полная карточка доступна через session get; для продолжения используйте nextCommand.",
    examples: [
      {
        description: "Найти незавершённые корневые поручения",
        command: "relay session list --unfinished --parent null --limit 20",
      },
    ],
  },
  get: {
    description: "Прочитать полное поручение, состояние и участие",
    details:
      "Возвращает содержание, итог, revision, currentRunId и сведения об участиях сессии. Для записи материалов используйте ревизию этой сессии и ID её активного run; --actor должен совпадать с его автором.\n\nsession intents показывает открытые намерения, session tree — потомков, session history — материалы, session context — составной контекст. checkpoint get читает полный материал по его ключу или ID.",
    examples: [
      {
        description: "Получить текущие revision и currentRunId",
        command: "relay session get S-session",
      },
    ],
  },
  start: {
    description: "Начать корневое поручение и первое участие",
    details:
      "Обязательны непустой title и автор. description — полное поручение, границы и ожидаемый результат в Markdown. Создаёт сессию open с ревизией 1 и активным run; повтор создаёт новую сессию.\n\n--client и --source-session-id связывают участие с внешним клиентом. Сведения о пользователе задаются через --user-name/--user-email или RELAY_USER_NAME/RELAY_USER_EMAIL. JSON operator несовместим с явными полями пользователя. Намерение внутри сессии создаётся через checkpoint open.",
    examples: [
      {
        description: "Сохранить поручение и начать участие",
        command:
          "relay session start --title 'Проверить восстановление поиска' --description 'Прочитать требования, проверить отказ API и повтор запроса, сохранить результаты.' --client terminal --actor human",
      },
    ],
  },
  history: {
    description: "Прочитать материалы проекта или выбранной сессии",
    details:
      "Без аргумента читает историю материалов всего проекта; с аргументом — выбранной сессии. Возвращает страницу контрольных точек в хронологическом порядке. Это журнал сохранённых намерений и материалов, не журнал произвольных изменений всех сущностей. Полная точка доступна через checkpoint get.",
    examples: [
      {
        description: "Прочитать материалы сессии",
        command: "relay session history S-session --limit 20",
      },
      {
        description: "Прочитать общую историю проекта",
        command: "relay session history --limit 20",
      },
    ],
  },
  transitions: {
    fork: {
      description: "Создать дочернее поручение из открытого намерения",
      details:
        "Позиционный аргумент — исходный checkpoint вида intent, а не сессия. Обязательны title и --run текущего участия родителя. --if-revision относится к родительской сессии; --actor совпадает с автором её активного run.\n\nСоздаёт ребёнка pending и повышает ревизию родителя атомарно. Исполнитель принимает ребёнка через session attach, используя уже ревизию дочерней сессии. Открытые намерения доступны через session intents.",
      examples: [
        {
          description: "Выделить дочернее поручение из намерения",
          command:
            "relay session fork CP-intent --title 'Проверить таймаут' --description 'Воспроизвести таймаут и сохранить фактический результат.' --run run-id --if-revision 2 --actor human",
        },
      ],
    },
    attach: {
      description: "Принять дочернее поручение к выполнению",
      details:
        "Аргумент — дочерняя сессия в pending. --if-revision принадлежит ребёнку, а не родителю. Создаёт активное участие нового автора и переводит ребёнка в open. Без явно заданного пользователя он наследуется от участия создателя в родителе; JSON operator:null отключает наследование. Родитель не меняется.",
      examples: [
        {
          description: "Начать выполнение выделенного поручения",
          command:
            "relay session attach S-child --client terminal --if-revision 1 --actor reviewer",
        },
      ],
    },
    pause: {
      description: "Приостановить активное участие в поручении",
      details:
        "Требуются сессия open, её revision, --run текущего участия, совпадающий автор и непустая reason. Закрывает текущий run как paused и переводит сессию в paused. Продолжение через session resume создаёт новое участие; старый runId повторно не используется.",
      examples: [
        {
          description: "Сохранить причину паузы",
          command:
            "relay session pause S-session --run run-id --reason 'Ожидается доступ к тестовой среде.' --if-revision 3 --actor human",
        },
      ],
    },
    resume: {
      description: "Продолжить приостановленное поручение",
      details:
        "Аргумент — сессия paused. Передайте её прочитанную ревизию и автора нового участия. Создаёт новый активный run и переводит сессию в open. --run не передаётся: новый currentRunId возвращается в результате. Причину продолжения можно сохранить через --reason.",
      examples: [
        {
          description: "Возобновить работу после паузы",
          command:
            "relay session resume S-session --reason 'Тестовая среда доступна.' --if-revision 4 --actor human",
        },
      ],
    },
    takeover: {
      description: "Передать активное поручение новому участнику",
      details:
        "Допустима сессия open. Обязательны её revision, новый автор и непустая reason. Завершает прежний run как transferred и создаёт активное участие указанного автора. --run не требуется; новый currentRunId возвращается в результате. Прежний участник больше не может писать под старым runId.",
      examples: [
        {
          description: "Зафиксировать передачу ответственности",
          command:
            "relay session takeover S-session --reason 'Проверку продолжает другой участник.' --if-revision 3 --actor reviewer",
        },
      ],
    },
    complete: {
      description: "Завершить поручение с фактическим итогом",
      details:
        "Требуются сессия open, её revision, текущий --run, совпадающий автор и непустой result. Все намерения должны быть закрыты, прямые дети завершены или отменены, результаты завершённых детей приняты в материалах соответствующих намерений.\n\nСохраняет итог и закрывает активное участие. session intents и session tree помогают найти оставшиеся обязательства. Повтор завершения не является no-op.",
      examples: [
        {
          description: "Сохранить итог выполненного поручения",
          command:
            "relay session complete S-session --run run-id --result 'Отказ API и повтор проверены; запрос сохраняется. Результаты приложены к задаче.' --if-revision 5 --actor human",
        },
      ],
    },
    cancel: {
      description: "Отменить незавершённое поручение с итогом",
      details:
        "Обязательны revision сессии и непустой result с причиной отмены. Для open передайте текущий --run и его автора; для pending/paused --run не передаётся. Перед отменой закройте намерения и детей, примите результаты завершённых дочерних поручений. Материалы и история сохраняются.",
      examples: [
        {
          description: "Отменить открытое поручение",
          command:
            "relay session cancel S-session --run run-id --result 'Проверка отменена после изменения требований.' --if-revision 3 --actor human",
        },
      ],
    },
  },
  tree: {
    description: "Прочитать сессию и всех её потомков",
    details:
      "Аргумент — корневая сессия выбранного поддерева. Возвращает страницу обхода в ширину, включая сам корень. Для полного дерева продолжайте по nextCommand. Содержимое одной сессии читается через session get.",
    examples: [
      {
        description: "Прочитать дерево поручения",
        command: "relay session tree S-session --limit 20",
      },
    ],
  },
  intents: {
    description: "Найти открытые намерения сессии",
    details:
      "По умолчанию выбирает незакрытые intent только указанной сессии. --include-children включает всех потомков. Намерение считается закрытым при последующем результате или отмене; исходный checkpoint неизменяем. Полный текст читается через checkpoint get.",
    examples: [
      {
        description: "Найти обязательства всего дерева",
        command: "relay session intents S-session --include-children --limit 20",
      },
    ],
  },
  context: {
    description: "Прочитать поручение, детей, намерения и страницу материалов",
    details:
      "Собирает карточку сессии, прямых детей, открытые намерения и страницу контрольных точек в согласованном чтении. --limit и --cursor ограничивают материалы. Для дальнейшего восстановления контекста используйте nextCommand, session tree и checkpoint get.",
    examples: [
      {
        description: "Восстановить контекст работы",
        command: "relay session context S-session --limit 20",
      },
    ],
  },
  checkpoint: {
    description: "Неизменяемые намерения и материалы выполнения",
    details:
      "open принимает сессию и создаёт намерение. save, complete и cancel принимают исходный intent и добавляют материал, результат или отмену. Все точки неизменяемы; повтор записи создаёт новый материал, если состояние допускает действие.\n\nДля каждой записи обязательны title, body, runId и автор активного участия. --if-revision всегда принадлежит сессии, а не checkpoint. Актуальные значения получайте через session get. Результат содержит sessionRevision — новую ревизию сессии.",
    examples: [
      { description: "Изучить запись намерения", command: "relay checkpoint open --help" },
      { description: "Прочитать сохранённый материал", command: "relay checkpoint get CP-intent" },
    ],
  },
  checkpointGet: {
    description: "Прочитать полное содержание контрольной точки",
    details:
      "Возвращает неизменяемый Markdown, автора, ссылки и принятые результаты детей. Состояние намерения определяется последующими материалами: читайте session history или session intents. Актуальные revision и currentRunId принадлежат сессии из карточки и читаются через session get. nextStep — сохранённый пользовательский текст.",
    examples: [
      { description: "Прочитать полный материал", command: "relay checkpoint get CP-intent" },
    ],
  },
  checkpointActions: {
    open: {
      description: "Открыть намерение в активной сессии",
      details:
        "Аргумент — сессия. Обязательны непустые title, body и --run (runId) активного участия; --actor должен совпадать с его автором. --if-revision — прочитанная ревизия сессии, а не checkpoint.\n\nСоздаёт intent и повышает ревизию сессии атомарно. body описывает замысел, границы и ожидаемую проверку. Для следующего изменения используйте sessionRevision результата или перечитайте session get. Дочернее поручение создаётся через session fork <ключ намерения>.",
      examples: [
        {
          description: "Зафиксировать проверяемое намерение",
          command:
            "relay checkpoint open S-session --run run-id --title 'Проверить повтор после отказа' --body 'Воспроизвести HTTP 503, повторить поиск и проверить сохранность запроса.' --if-revision 1 --actor human",
        },
      ],
    },
    save: {
      description: "Добавить материал к открытому намерению",
      details:
        "Аргумент — исходный checkpoint вида intent. Обязательны title, body, текущий --run и автор активного участия. --if-revision принадлежит сессии намерения; получайте её через session get. Добавляет новый материал, не меняя исходную точку и не закрывая намерение.\n\n--accept принимает завершённые прямые дочерние сессии этого намерения; повторяйте параметр. --references сохраняет снимки ссылок на сущности. Повтор save может создать ещё один материал того же содержания.",
      examples: [
        {
          description: "Сохранить промежуточные результаты",
          command:
            "relay checkpoint save CP-intent --run run-id --title 'Отказ воспроизведён' --body 'HTTP 503 воспроизведён. Исходный запрос сохраняется.' --remaining 'Проверить таймаут.' --if-revision 2 --actor human",
        },
      ],
    },
    complete: {
      description: "Завершить намерение новым результатом",
      details:
        "Аргумент — исходный intent. Обязательны title, body, текущий --run и совпадающий автор; --if-revision относится к сессии. Создаёт результат и закрывает намерение, исходный checkpoint сохраняется.\n\nПрямые дети намерения должны быть завершены или отменены. Результаты завершённых детей примите через --accept сейчас либо в предыдущем материале. Укажите фактическую работу и проверки в body, done и checks. Сессию затем можно завершить отдельно через session complete.",
      examples: [
        {
          description: "Сохранить результат проверки",
          command:
            "relay checkpoint complete CP-intent --run run-id --title 'Повтор проверен' --body 'Запрос сохраняется после HTTP 503 и таймаута.' --checks 'Оба сценария проверены вручную.' --if-revision 3 --actor human",
        },
      ],
    },
    cancel: {
      description: "Отменить намерение новым материалом",
      details:
        "Аргумент — исходный intent. Обязательны title, непустое body с причиной, текущий --run и автор активного участия. --if-revision принадлежит сессии. Создаёт отмену, не изменяя исходный материал.\n\nПеред закрытием завершите или отмените прямых детей, примите результаты завершённых детей через --accept либо ранее сохранённые материалы. История доступна через session history.",
      examples: [
        {
          description: "Зафиксировать отказ от намерения",
          command:
            "relay checkpoint cancel CP-intent --run run-id --title 'Проверка отложена' --body 'Требование изменено; прежний сценарий больше не актуален.' --if-revision 2 --actor human",
        },
      ],
    },
  },
  fields: {
    client: "Имя внешнего клиента участия, например terminal",
    sourceSessionId: "ID сессии внешнего клиента; не ID сессии Relay",
    userName: "Имя пользователя участия; иначе RELAY_USER_NAME",
    userEmail: "Почта пользователя участия; иначе RELAY_USER_EMAIL",
    reason: "Причина подключения, паузы или передачи в Markdown; обязательна для pause/takeover",
    description: "Полное поручение в Markdown: цель, основания, границы и ожидаемый результат",
    result: "Непустой итог поручения или причина отмены в Markdown; обязателен при закрытии",
    body: "Непустой полный Markdown намерения или материала; обязателен при записи",
    summary: "Краткое содержание материала",
    done: "Фактически выполненная работа в Markdown",
    remaining: "Оставшиеся обязательства и ограничения в Markdown",
    nextStep: "Сохранённый следующий шаг в Markdown",
    checks: "Фактические проверки, их результаты и ограничения в Markdown",
    query: "Поиск",
    status: "Состояние",
    parent: "Родитель",
    unfinished: "Только незавершённые",
    actorFilter: "Автор участия",
    title: "Заголовок",
    branch: "Ключ или ID сессии поручения",
    intent: "Ключ или ID исходного checkpoint вида intent, не сессии и не последующего материала",
    runId: "ID активного участия: currentRunId из session get; в JSON — runId или run",
    forkTitle: "Заголовок дочернего поручения",
    includeChildren: "Включить потомков",
    checkpointTitle: "Заголовок материала",
    reference: "Ключ или ID сущности, ссылка на которую сохраняется снимком",
    acceptedSessionId:
      "Только постоянный ID завершённого прямого ребёнка исходного намерения; поле id из session get, ключ не принимается",
  },
  conflictingOperator: "operator несовместим с userName/userEmail",
} as const;
