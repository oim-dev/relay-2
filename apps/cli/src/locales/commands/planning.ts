/**
 * Русские тексты команд планов, этапов и релизов.
 */
export const planningCommandMessages = {
  entities: {
    plan: {
      group: {
        description: "Планы работы и этапы",
        details:
          "План связывает цель, границы и явный состав задач по этапам. Создайте черновик через plan create, добавьте этапы и задачи, затем используйте start, progress и complete. Для завершения и отмены нужен содержательный итог.\n\nЭтапы и их состав изменяются под ревизией плана. Одна задача может входить только в один этап открытого плана; перенос выполняет plan stage task transfer. Закрытые планы сохраняют историю и доступны только для чтения.",
        examples: [
          { description: "Найти планы проекта", command: "relay plan list" },
          { description: "Проверить готовность состава", command: "relay plan progress PLN-1" },
        ],
      },
      list: {
        description: "Прочитать страницу планов",
        details:
          "Фильтры --q и --status применяются до пагинации. Статусы: draft, active, completed, cancelled. Полное содержание и ревизия доступны через plan get, готовность — plan progress. Для продолжения используйте nextCommand.",
        examples: [
          {
            description: "Найти активные планы",
            command: "relay plan list --status active --limit 20",
          },
        ],
      },
      get: {
        description: "Прочитать полный план и его ревизию",
        details:
          "Возвращает цель, основания, границы, участников, область воздействия, этапы и сохранённый итог. Используйте revision этой записи для изменения плана, этапов и их состава. Этапы читаются через plan stage list/get, задачи этапа — plan stage task list, готовность — plan progress.",
        examples: [
          { description: "Прочитать план перед изменением", command: "relay plan get PLN-1" },
        ],
      },
      create: {
        description: "Создать черновик плана",
        details:
          "Обязателен непустой title через --title или --input. Новый план имеет статус draft и пустой список этапов. goal объясняет цель, rationale — основания, boundaries — границы, expectedResult — ожидаемый результат.\n\n--scope принимает ссылки на предметные записи, --participants — имена участников; повторяйте параметры. Состав задач задаётся отдельно через plan stage create и plan stage task add. Для начала плана нужны непустая цель и хотя бы одна задача.",
        examples: [
          {
            description: "Сформулировать цель и границы плана",
            command:
              "relay plan create --title 'Восстановление поиска' --goal 'Повторять поиск без потери запроса.' --boundaries 'Меняем интерфейс ошибок, алгоритм поиска сохраняется.' --expected-result 'Пользователь может повторить запрос после отказа API.' --actor human",
          },
        ],
      },
      update: {
        description: "Изменить переданные поля открытого плана",
        details:
          "Передайте хотя бы одно поле и revision из plan get. Неуказанные поля сохраняются. --scope и --participants заменяют соответствующие наборы целиком; пустые массивы передаются через --input. Этапы и задачи меняются отдельными командами plan stage. Завершённые и отменённые планы доступны только для чтения.",
        examples: [
          {
            description: "Уточнить цель плана",
            command:
              "relay plan update PLN-1 --goal 'Обрабатывать таймаут и отказ API с сохранением запроса.' --if-revision 1 --actor human",
          },
        ],
      },
      progress: {
        description: "Проверить фактическую готовность плана",
        details:
          "Вычисляет готовность этапов и всего состава по обязательствам включённых задач. Сохранённый статус плана и фактическое выполнение различаются. Проверка ничего не завершает; после выполнения работ используйте plan complete с содержательным результатом.",
        examples: [
          {
            description: "Проверить состав перед завершением",
            command: "relay plan progress PLN-1",
          },
        ],
      },
      transitions: {
        start: {
          description: "Начать выполнение черновика плана",
          details:
            "Допустим только статус draft. Требуются непустая goal и хотя бы одна включённая задача. Передайте revision из plan get. Команда фиксирует статус active и время начала; выполнение работы остаётся за участниками.",
          examples: [
            {
              description: "Начать подготовленный план",
              command: "relay plan start PLN-1 --if-revision 3 --actor human",
            },
          ],
        },
        complete: {
          description: "Завершить выполненный план с итогом",
          details:
            "Обязателен непустой result через --result, --result-file или --input. Проверяет фактическое выполнение всего состава, затем сохраняет итог и закрывает план. Ревизия принадлежит плану. Причины отказа раскрывает plan progress; после завершения план доступен только для чтения.",
          examples: [
            {
              description: "Сохранить фактический итог",
              command:
                "relay plan complete PLN-1 --result 'Повтор поиска реализован. Проверены таймаут, HTTP 503 и успешное восстановление.' --if-revision 4 --actor human",
            },
          ],
        },
        cancel: {
          description: "Отменить открытый план с объяснением",
          details:
            "Обязателен непустой result с причиной отмены и фактическим итогом. Передайте revision плана. Готовность задач для отмены не требуется; состав сохраняется как история. Отменённый план доступен только для чтения.",
          examples: [
            {
              description: "Зафиксировать отмену плана",
              command:
                "relay plan cancel PLN-1 --result 'Работа остановлена после изменения требований; выполненные проверки сохранены в задачах.' --if-revision 3 --actor human",
            },
          ],
        },
      },
    },
    release: {
      group: {
        description: "Релизы из планов работы",
        details:
          "Релиз фиксирует выпуск набора планов целиком. Создайте запись через release create, проверьте состав и progress, затем зафиксируйте publish. Отменённый релиз можно вернуть в planned через release plan; выпущенный доступен только для чтения. Сборку и публикацию программ выполняют внешние инструменты.",
        examples: [{ description: "Прочитать релизы проекта", command: "relay release list" }],
      },
      list: {
        description: "Прочитать страницу релизов",
        details:
          "Фильтры --q и --status применяются до пагинации. Статусы: planned, released, cancelled. Полное содержание доступно через release get, состав — release plans, готовность — release progress. Для следующей страницы используйте nextCommand.",
        examples: [
          {
            description: "Найти запланированные выпуски",
            command: "relay release list --status planned --limit 20",
          },
        ],
      },
      get: {
        description: "Прочитать полный релиз и его ревизию",
        details:
          "Возвращает обозначение версии, описание, дату, состав и сохранённый статус выпуска. Перед изменением используйте revision этой записи. release plans читает планы состава, release progress проверяет готовность их работы.",
        examples: [
          { description: "Прочитать выпуск перед изменением", command: "relay release get REL-1" },
        ],
      },
      create: {
        description: "Создать запланированный релиз",
        details:
          "Обязательны title, releaseVersion и непустой набор plans. Повторяйте --plans для каждого плана. Новый релиз имеет статус planned; отменённые планы нельзя включать в новый состав.\n\n--release-version задаёт обозначение выпуска, --version показывает версию CLI. JSON принимает releaseVersion/version и plans/planIds как альтернативные имена; одновременно оба имени одного поля запрещены. --planned-for — дата YYYY-MM-DD. Релиз фиксирует сведения о выпуске, не запускает сборку.",
        examples: [
          {
            description: "Собрать выпуск из плана",
            command:
              "relay release create --title 'Восстановление поиска' --release-version 1.2.0 --plans PLN-1 --actor human",
          },
        ],
      },
      update: {
        description: "Изменить переданные поля невыпущенного релиза",
        details:
          "Передайте хотя бы одно поле и revision из release get. Непереданные поля сохраняются; --plans заменяет весь непустой состав, планы включаются целиком. --release-version меняет обозначение выпуска. Выпущенный релиз доступен только для чтения; готовность перед publish проверяет release progress.",
        examples: [
          {
            description: "Уточнить обозначение выпуска",
            command:
              "relay release update REL-1 --release-version 1.2.1 --if-revision 1 --actor human",
          },
        ],
      },
      progress: {
        description: "Проверить готовность полного состава релиза",
        details:
          "Для готовности релиза каждый план должен иметь статус completed и фактически выполненные обязательства задач. Одного plan progress.completed=true недостаточно: явно завершите план через plan complete с непустым --result. Команда ничего не публикует; после внешних проверок выпуск фиксируется через release publish.",
        examples: [
          {
            description: "Проверить выпуск перед публикацией",
            command: "relay release progress REL-1",
          },
        ],
      },
      transitions: {
        plan: {
          description: "Вернуть отменённый релиз в планирование",
          details:
            "Передайте ревизию релиза. Повтор для planned ничего не меняет после проверки ревизии. Возврат из cancelled заново проверяет весь состав; отменённые планы должны быть исключены через release update. Выпущенный релиз изменить нельзя.",
          examples: [
            {
              description: "Возобновить планирование выпуска",
              command: "relay release plan REL-1 --if-revision 2 --actor human",
            },
          ],
        },
        publish: {
          description: "Зафиксировать выпуск готового релиза",
          details:
            "Релиз должен быть в planned, а каждый план состава — явно завершён в completed с фактически выполненными обязательствами задач. При готовых задачах сначала выполните plan complete с непустым --result. Передайте revision из release get. Сохраняет released, автора и время выпуска; после этого запись доступна только для чтения. Сборку, тестирование и публикацию программ выполняйте внешними инструментами до фиксации результата.",
          examples: [
            {
              description: "Зафиксировать проверенный выпуск",
              command: "relay release publish REL-1 --if-revision 3 --actor human",
            },
          ],
        },
        cancel: {
          description: "Отменить невыпущенный релиз",
          details:
            "Передайте revision релиза. Сохраняет статус cancelled, не изменяя включённые планы. Повтор отмены не меняет данные после проверки ревизии. Вернуть запись в planned можно через release plan; выпущенный релиз отменить нельзя.",
          examples: [
            {
              description: "Отменить запланированный выпуск",
              command: "relay release cancel REL-1 --if-revision 1 --actor human",
            },
          ],
        },
      },
    },
  },
  stage: {
    description: "Этапы плана и их порядок",
    details:
      "Этапы принадлежат плану и используют его ревизию. Создание выдаёт ID этапа; list/get позволяют получить ID и тексты. Состав задач меняется через plan stage task, порядок этапов — через move. Закрытый план не редактируется.",
    examples: [
      { description: "Получить этапы и ревизию плана", command: "relay plan stage list PLN-1" },
    ],
  },
  stageList: {
    description: "Прочитать этапы в заданном порядке",
    details:
      "Аргумент — план. Возвращает страницу этапов вместе с ревизией плана-владельца. ID этапа используется в get/update/move/remove и plan stage task. Пагинация не меняет заданный порядок.",
    examples: [
      {
        description: "Прочитать первую страницу этапов",
        command: "relay plan stage list PLN-1 --limit 20",
      },
    ],
  },
  stageGet: {
    description: "Прочитать полный этап и ревизию плана",
    details:
      "Аргументы: план и ID этапа из plan stage list. Возвращает содержание этапа вместе с ревизией плана. Задачи этапа читаются через plan stage task list, готовность всего плана — plan progress.",
    examples: [
      { description: "Прочитать содержание этапа", command: "relay plan stage get PLN-1 stage-id" },
    ],
  },
  stageActions: {
    create: {
      description: "Создать этап открытого плана",
      details:
        "Аргумент — план, обязательное поле — title через --title или --input. ID этапа выдаётся при создании. --before вставляет перед указанным ID, отсутствие параметра — в конец. --if-revision принадлежит плану. Задачи включаются отдельно через plan stage task add.",
      examples: [
        {
          description: "Добавить этап проверки",
          command:
            "relay plan stage create PLN-1 --title 'Проверка восстановления' --outcome 'Подтверждён повтор без потери ввода.' --completion-conditions 'Проверены таймаут и HTTP 503.' --if-revision 1 --actor human",
        },
      ],
    },
    update: {
      description: "Изменить переданные тексты этапа",
      details:
        "Аргументы: план и ID этапа. Передайте хотя бы title, summary, outcome или completionConditions; непереданные поля сохраняются. --if-revision относится к плану, а не этапу. Состав задач меняется через plan stage task.",
      examples: [
        {
          description: "Уточнить ожидаемый результат этапа",
          command:
            "relay plan stage update PLN-1 stage-id --outcome 'Повтор работает после сетевого отказа и таймаута.' --if-revision 2 --actor human",
        },
      ],
    },
    move: {
      description: "Переместить этап внутри плана",
      details:
        "Аргументы: план и ID перемещаемого этапа. --before задаёт ID следующего этапа; без параметра этап переносится в конец. --if-revision принадлежит плану. Задачи сохраняют принадлежность этапу.",
      examples: [
        {
          description: "Переместить этап в конец",
          command: "relay plan stage move PLN-1 stage-id --if-revision 3 --actor human",
        },
      ],
    },
    remove: {
      description: "Удалить пустой этап плана",
      details:
        "Аргументы: план и ID этапа. Удаляется только пустой этап; сначала исключите или перенесите его задачи через plan stage task. Ревизия принадлежит плану. Сами задачи не удаляются.",
      examples: [
        {
          description: "Удалить ненужный пустой этап",
          command: "relay plan stage remove PLN-1 stage-id --if-revision 4 --actor human",
        },
      ],
    },
  },
  stageTask: {
    description: "Явный состав задач этапа",
    details:
      "Изменения состава используют ревизию плана, а не задачи. Одна задача включается только в один этап открытого плана; существующее включение переносится через transfer. Исторические включения закрытых планов сохраняются.",
    examples: [
      {
        description: "Прочитать задачи этапа",
        command: "relay plan stage task list PLN-1 stage-id",
      },
    ],
  },
  stageTaskList: {
    description: "Прочитать задачи этапа",
    details:
      "Аргументы: план и ID этапа. Возвращает страницу его задач и ревизию плана. Полная задача читается через task get; включения задачи в другие планы — plan task memberships.",
    examples: [
      {
        description: "Прочитать страницу задач этапа",
        command: "relay plan stage task list PLN-1 stage-id --limit 20",
      },
    ],
  },
  stageTaskRemove: {
    description: "Исключить задачу из этапа",
    details:
      "Аргументы: план, ID этапа, задача. --if-revision принадлежит плану. Удаляется только включение; задача и её ревизия сохраняются. Для атомарной смены этапа или плана используйте transfer.",
    examples: [
      {
        description: "Убрать включение задачи",
        command:
          "relay plan stage task remove PLN-1 stage-id PRODUCT-1 --if-revision 3 --actor human",
      },
    ],
  },
  stageTaskAdd: {
    description: "Включить задачу в этап",
    details:
      "Аргументы: план, ID этапа, задача. --if-revision принадлежит плану. Задача не должна уже находиться в другом этапе открытого плана. Повтор того же включения не меняет данные после проверки ревизии. Содержание задачи сохраняется.",
    examples: [
      {
        description: "Включить задачу в подготовленный этап",
        command: "relay plan stage task add PLN-1 stage-id PRODUCT-1 --if-revision 2 --actor human",
      },
    ],
  },
  stageTaskTransfer: {
    description: "Атомарно перенести задачу между этапами или планами",
    details:
      "Аргументы по порядку: исходный план, задача, ID целевого этапа. Обязательны --target-plan и непустая reason через --reason либо --reason-file. Для исходного плана передайте --if-revision или --expected-version; для целевого — --target-revision или --target-version. Если переданы обе формы предусловия владельца, проверяются обе.\n\nДля переноса внутри одного плана укажите его же в --target-plan; оба предусловия описывают одно исходное состояние. При использовании локального CAS передавайте одинаковые ревизии. Планы должны быть открыты. Перенос включения атомарен, сама задача не меняется. ID этапов доступны через plan stage list, исходное включение — plan task memberships.",
    examples: [
      {
        description: "Перенести задачу в этап другого плана",
        command:
          "relay plan stage task transfer PLN-1 PRODUCT-1 target-stage-id --target-plan PLN-2 --if-revision 3 --target-revision 2 --reason 'Проверка выделена в отдельный план.' --actor human",
      },
      {
        description:
          "Перенести по aggregateVersion обоих планов из get --with-versions; подставьте прочитанные токены",
        command:
          "relay plan stage task transfer PLN-1 PRODUCT-1 target-stage-id --target-plan PLN-2 --expected-version 'source-aggregate-version' --target-version 'target-aggregate-version' --reason 'Проверка выделена в отдельный план.' --actor human",
      },
    ],
  },
  task: {
    description: "Участие задач в планах",
    details:
      "plan task memberships находит этапы, содержащие задачу, включая исторические включения. Изменение состава выполняют plan stage task add/remove/transfer под ревизиями планов.",
    examples: [
      { description: "Найти включения задачи", command: "relay plan task memberships PRODUCT-1" },
    ],
  },
  memberships: {
    description: "Найти этапы, содержащие задачу",
    details:
      "Аргумент — задача, а не план. Возвращает страницу включений в этапы планов. Исторические включения закрытых планов не резервируют задачу для нового открытого плана. Для переноса прочитайте ревизии исходного и целевого планов.",
    examples: [
      {
        description: "Проверить участие задачи в планах",
        command: "relay plan task memberships PRODUCT-1 --limit 20",
      },
    ],
  },
  releasePlans: {
    description: "Прочитать планы в составе релиза",
    details:
      "Аргумент — релиз. Возвращает страницу планов его полного состава и метаданные владельца. Полный план читается через plan get; набор планов заменяется целиком через release update --plans под ревизией релиза.",
    examples: [
      { description: "Прочитать состав выпуска", command: "relay release plans REL-1 --limit 20" },
    ],
  },
  fields: {
    query: "Поиск по содержанию",
    status: "Состояние",
    title: "Непустой однострочный заголовок плана, этапа или релиза обычным текстом",
    summary: "Краткая текстовая аннотация плана, этапа или релиза",
    goal: "Цель плана в Markdown: какой результат должен быть достигнут",
    rationale: "Основания плана в Markdown: требования, проблемы и причины работы",
    boundaries: "Границы плана в Markdown: что входит в работу и что исключено",
    expectedResult: "Ожидаемый проверяемый результат плана в Markdown",
    releaseDescription: "Полное описание выпуска в Markdown: изменения, ограничения и проверки",
    result: "Непустой итог выполнения или отмены плана в Markdown; обязателен при закрытии",
    outcome: "Ожидаемый результат этапа в Markdown",
    completionConditions: "Условия проверки и завершения этапа в Markdown",
    reason: "Непустое текстовое обоснование переноса задачи; обязательно",
    scope: "Ссылка на запись предметной области; переданный набор заменяет прежний",
    participant: "Однострочное имя участника плана; переданный набор заменяет прежний",
    releasePlan: "Ключ или ID включаемого плана; переданный набор заменяет прежний",
    releaseVersion: "Непустое однострочное обозначение выпуска; формат SemVer не требуется",
    plannedFor: "Плановая дата выпуска YYYY-MM-DD",
    stageId: "ID этапа",
    insertBefore: "Вставить перед этапом; без параметра — в конец",
    moveBefore: "Перед этапом; без параметра — в конец",
    task: "Задача",
    transferredTask: "Переносимая задача",
    targetStageId: "ID целевого этапа",
    targetPlan: "Целевой план",
    targetRevision: "Прочитанная локальная ревизия целевого плана",
    targetVersion: "Прочитанный aggregateVersion целевого плана; непрозрачный переносимый токен",
  },
} as const;
