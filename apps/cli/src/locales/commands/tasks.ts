const criterionWriteRule =
  "В колонке done любые изменения критериев запрещены: сначала верните задачу в другую колонку через task move и используйте новую ревизию задачи.";

/**
 * Русские тексты команд задач, их связей, критериев и обсуждений.
 */
export const taskCommandMessages = {
  task: {
    description: "Задачи, критерии, обсуждения и зависимости",
    details:
      "Задача описывает конкретную работу на доске продукта или приложения. Начните с task list, прочитайте содержание и revision через task get. Содержание меняется через update, колонка и доска — через move, обязательства — через parent, dependency и criterion.\n\nКлючи, алиасы и ID разрешаются в выбранном проекте. Изменения требуют прочитанной ревизии задачи и автора. Комментарии добавляются независимо от ревизии содержания. Готовность с причинами показывает task progress; участие в планах — plan task memberships.",
    examples: [
      {
        description: "Выбрать незавершённую работу",
        command: "relay task list --completion unfinished",
      },
      { description: "Прочитать содержание задачи", command: "relay task get PRODUCT-1" },
    ],
  },
  list: {
    description: "Найти задачи по доске, содержанию и готовности",
    details:
      "Возвращает страницу кратких задач; полное описание читается через task get. Фильтры применяются до пагинации. finished включает done и cancelled; это сохранённое состояние, а не доказательство выполнения. ready выбирает колонку ready без блокеров старта.\n\n--product-target включает дочерние требования выбранной цели. Для следующей страницы используйте nextCommand; после изменения данных начните чтение заново.",
    examples: [
      {
        description: "Прочитать незавершённые задачи доски",
        command: "relay task list --board product --completion unfinished --limit 20",
      },
      {
        description: "Найти задачи без блокеров старта",
        command: "relay task list --readiness ready",
      },
    ],
  },
  get: {
    description: "Прочитать полную карточку задачи",
    details:
      "Возвращает содержание и ревизию задачи по текущему ключу, алиасу или ID. Используйте эту revision в --if-revision при изменении задачи, её критериев или связей.\n\nКритерии читаются через task criterion list, обсуждение — task comment list, прямые дети — task children, зависимости — task dependency list. task progress раскрывает причины неготовности, plan task memberships — включения в этапы планов.",
    examples: [
      { description: "Прочитать описание и ревизию", command: "relay task get PRODUCT-1" },
      { description: "Проверить обязательства", command: "relay task progress PRODUCT-1" },
    ],
  },
  create: {
    description: "Создать задачу с критериями и связями атомарно",
    details:
      "Создаёт задачу и все переданные критерии и связи одной операцией. По умолчанию выбираются доска BOARD-PRODUCT и колонка inbox. Автор обязателен: --actor или RELAY_ACTOR.\n\nОписание — полный Markdown: цель и основания, конкретная работа, границы и способ проверки. Критерии передаются JSON-массивом объектов с обязательным title и необязательными summary и description. Новые критерии невыполнены; их ID выдаёт результат. Ссылки передавайте повторением --targets, --dependencies или --related. На доске продукта цели — фичи и сценарии, на доске приложения — его активные реализации.\n\n--input/--input-file принимают весь объект вместо отдельных полей; JSON использует acceptanceCriteria. После создания доступны task get, task criterion list и task progress.",
    examples: [
      {
        description: "Создать задачу с описанием и критерием проверки",
        command:
          'relay task create \\\n    --board product \\\n    --title \'Сохранить запрос при ошибке поиска\' \\\n    --description \'## Цель\n\nПользователь может повторить поиск после отказа API.\n\n## Работа и границы\n\nСохранить введённый запрос и показать кнопку повтора. Алгоритм поиска не меняется.\n\n## Проверка\n\nВоспроизвести отказ API и убедиться, что повтор использует исходный запрос.\' \\\n    --acceptance-criteria \'[{"title":"Запрос сохраняется после ошибки","description":"Воспроизвести отказ API и повторить поиск без нового ввода."}]\' \\\n    --actor human',
      },
      {
        description: "Прочитать описание из подготовленного файла",
        command:
          "relay task create --title 'Уточнить обработку ошибок' --description-file ./task.md --actor human",
      },
    ],
  },
  update: {
    description: "Изменить переданные поля содержания задачи",
    details:
      "Передайте хотя бы одно поле: title, description или targets. Неуказанные поля сохраняются. --targets заменяет весь набор целей; --input '{\"targets\":[]}' очищает его. --input нельзя смешивать с отдельными предметными полями.\n\nПрочитайте task get и передайте revision задачи в --if-revision. При конфликте перечитайте и согласуйте изменения. Колонка меняется через task move, критерии — task criterion, родитель и зависимости — отдельными командами.",
    examples: [
      {
        description: "Обновить заголовок при прочитанной ревизии 3",
        command:
          "relay task update PRODUCT-1 --title 'Уточнить обработку ошибок' --if-revision 3 --actor human",
      },
      {
        description: "Явно очистить набор целей",
        command:
          "relay task update PRODUCT-1 --input '{\"targets\":[]}' --if-revision 3 --actor human",
      },
    ],
  },
  move: {
    description: "Переместить задачу в колонку или на доску",
    details:
      "Укажите хотя бы --column или --board; неуказанное значение сохраняется. Требуется revision задачи из task get. Постоянный ID сохраняется. При переносе на другую доску цели должны быть с ней совместимы; лишние цели предварительно снимите через task update.\n\nПереход в done проверяет собственные критерии и обязательства. task progress показывает причины отказа. Перемещение не выполняет внешние проверки за пользователя.",
    examples: [
      {
        description: "Передать задачу на проверку",
        command: "relay task move PRODUCT-1 --column review --if-revision 3 --actor human",
      },
    ],
  },
  progress: {
    description: "Фактические обязательства и блокеры задачи",
    details:
      "Вычисляет выполнение задачи, возможность завершения и блокеры с учётом критериев, детей и обязательных зависимостей. Сохранённая колонка сама по себе не доказывает выполнение. Результат относится к согласованному чтению; исправляйте содержание и связи адресными командами, затем проверяйте прогресс заново.",
    examples: [
      { description: "Разобрать причины неготовности", command: "relay task progress PRODUCT-1" },
    ],
  },
  children: {
    description: "Прочитать прямые дочерние задачи",
    details:
      "Аргумент — ключ или ID родительской задачи. Возвращает страницу только прямых детей; все потомки автоматически не раскрываются. Назначение родителя меняется через task parent set/clear под ревизией дочерней задачи.",
    examples: [
      {
        description: "Прочитать страницу подзадач",
        command: "relay task children PRODUCT-1 --limit 20",
      },
    ],
  },
  parent: {
    description: "Назначение родителя задачи",
    details:
      "У задачи не более одного родителя. set и clear изменяют дочернюю задачу и требуют её ревизию, а не ревизию родителя. Родительство входит в граф обязательств; циклы отклоняются.",
    examples: [
      {
        description: "Назначить родителя дочерней задаче",
        command: "relay task parent set PRODUCT-2 PRODUCT-1 --if-revision 1 --actor human",
      },
    ],
  },
  parentClear: {
    description: "Снять родителя задачи",
    details:
      "Аргумент — дочерняя задача; --if-revision принадлежит ей. Снимает только родительскую связь, обе задачи сохраняются. Повтор при уже отсутствующем родителе не меняет данные, но ревизия всё равно проверяется.",
    examples: [
      {
        description: "Сделать задачу самостоятельной",
        command: "relay task parent clear PRODUCT-2 --if-revision 2 --actor human",
      },
    ],
  },
  parentSet: {
    description: "Назначить родителя задачи",
    details:
      "Аргументы по порядку: дочерняя задача, родитель. Требуется ревизия дочерней задачи. Самоссылки и циклы обязательств отклоняются; новому невыполненному ребёнку нельзя назначить завершённого родителя. Дети выбранного родителя читаются через task children.",
    examples: [
      {
        description: "Включить задачу в состав родительской",
        command: "relay task parent set PRODUCT-2 PRODUCT-1 --if-revision 1 --actor human",
      },
    ],
  },
  dependency: {
    description: "Обязательные зависимости задачи",
    details:
      "Зависимость — другая задача, выполнение которой входит в обязательства текущей. Обычная связь task link не является обязательством. Изменение зависимости требует ревизии первой задачи; циклы отклоняются.",
    examples: [
      { description: "Прочитать зависимости", command: "relay task dependency list PRODUCT-2" },
    ],
  },
  dependencyList: {
    description: "Прочитать прямые зависимости задачи",
    details:
      "Возвращает страницу прямых зависимостей вместе с ревизией задачи-владельца. Это не полный транзитивный граф; последствия зависимостей показывает task progress.",
    examples: [
      {
        description: "Прочитать обязательные зависимости",
        command: "relay task dependency list PRODUCT-2 --limit 20",
      },
    ],
  },
  dependencyRemove: {
    description: "Снять обязательную зависимость",
    details:
      "Аргументы: изменяемая задача, задача-зависимость. --if-revision относится к первой задаче. Снимается только связь; обе записи сохраняются. Ревизия проверяется даже при уже отсутствующей зависимости.",
    examples: [
      {
        description: "Снять обязательство",
        command: "relay task dependency remove PRODUCT-2 PRODUCT-1 --if-revision 2 --actor human",
      },
    ],
  },
  dependencyAdd: {
    description: "Добавить обязательную зависимость",
    details:
      "Аргументы: изменяемая задача, задача-зависимость. --if-revision относится к первой задаче. Самоссылка и цикл отклоняются. Для обычной информационной связи используйте task link. После изменения task progress объясняет влияние зависимости.",
    examples: [
      {
        description: "Потребовать выполнения другой задачи",
        command: "relay task dependency add PRODUCT-2 PRODUCT-1 --if-revision 1 --actor human",
      },
    ],
  },
  criterion: {
    description: "Критерии приёмки задачи",
    details: `Критерий содержит заголовок, аннотацию, полное описание проверки и отметку выполнения. ID получайте через task criterion list. Все изменения используют revision задачи из task get или списка критериев. complete фиксирует отметку, внешнюю проверку выполняет человек или другой инструмент. Изменение текста критерия сбрасывает отметку выполнения и требует повторной приёмки.\n\n${criterionWriteRule}`,
    examples: [
      { description: "Прочитать критерии задачи", command: "relay task criterion list PRODUCT-1" },
    ],
  },
  criterionList: {
    description: "Прочитать критерии задачи",
    details:
      "Возвращает страницу критериев с их ID, содержанием и ревизией задачи-владельца. Для чтения одного критерия используйте task criterion get <задача> <ID>; для изменений нужна revision задачи, а не отдельная ревизия критерия.",
    examples: [
      {
        description: "Получить ID критериев и ревизию владельца",
        command: "relay task criterion list PRODUCT-1 --limit 20",
      },
    ],
  },
  criterionGet: {
    description: "Прочитать полное содержание критерия",
    details:
      "Аргументы по порядку: задача и ID её критерия из task criterion list. Возвращает критерий и ревизию задачи. Описание должно объяснять проверяемый результат и способ проверки. complete фиксирует выполнение, reopen снимает отметку; изменение текста через update тоже сбрасывает её и требует повторной приёмки.",
    examples: [
      {
        description: "Прочитать один критерий",
        command: "relay task criterion get PRODUCT-1 criterion-id",
      },
    ],
  },
  criterionActions: {
    add: {
      description: "Добавить критерий приёмки",
      details: `Требуется непустой title через --title или --input. summary — краткая формулировка, description — полные условия и способ проверки в Markdown. Новый критерий невыполнен. --if-revision относится к задаче; ID нового критерия выдаёт результат и task criterion list.\n\n${criterionWriteRule}`,
      examples: [
        {
          description: "Добавить проверяемое условие",
          command:
            "relay task criterion add PRODUCT-1 --title 'Запрос сохраняется после ошибки' --description 'Вызвать отказ API и проверить повтор без потери запроса.' --if-revision 1 --actor human",
        },
      ],
    },
    update: {
      description: "Изменить переданные тексты критерия",
      details: `Аргументы: задача и ID критерия. Укажите хотя бы title, summary или description; неуказанные поля сохраняются. --if-revision — ревизия задачи. Изменение любого текста сбрасывает отметку выполнения, её автора и время: нужна повторная приёмка через complete. При неизменном содержании отметка и ревизия сохраняются, но исходная ревизия всё равно проверяется.\n\n${criterionWriteRule}`,
      examples: [
        {
          description: "Уточнить способ проверки",
          command:
            "relay task criterion update PRODUCT-1 criterion-id --description 'Проверить повтор после HTTP 503.' --if-revision 2 --actor human",
        },
      ],
    },
    complete: {
      description: "Отметить выполнение критерия",
      details: `После фактической проверки передайте задачу, ID критерия и revision задачи. Сохраняет отметку выполнения с автором и временем. Это не запуск теста. Готовность всей задачи показывает task progress.\n\n${criterionWriteRule}`,
      examples: [
        {
          description: "Зафиксировать выполненную проверку",
          command:
            "relay task criterion complete PRODUCT-1 criterion-id --if-revision 3 --actor human",
        },
      ],
    },
    reopen: {
      description: "Снять отметку выполнения критерия",
      details: `Аргументы: задача и ID критерия; ревизия принадлежит задаче. Убирает отметку выполнения, её автора и время.\n\n${criterionWriteRule}`,
      examples: [
        {
          description: "Вернуть критерий на проверку",
          command:
            "relay task criterion reopen PRODUCT-1 criterion-id --if-revision 4 --actor human",
        },
      ],
    },
    remove: {
      description: "Удалить критерий задачи",
      details: `Аргументы: задача и ID критерия из task criterion list. Удаляет выбранный критерий под ревизией задачи; содержание самой задачи и остальные критерии сохраняются.\n\n${criterionWriteRule}`,
      examples: [
        {
          description: "Убрать лишний критерий",
          command:
            "relay task criterion remove PRODUCT-1 criterion-id --if-revision 3 --actor human",
        },
      ],
    },
  },
  comment: {
    description: "Неизменяемые комментарии задачи",
    details:
      "Комментарии образуют независимый дописываемый журнал. add требует автора, но не --if-revision и не меняет ревизию содержания задачи. Повтор add создаёт новый комментарий. Прочитанные записи не редактируются.",
    examples: [
      { description: "Прочитать обсуждение", command: "relay task comment list PRODUCT-1" },
    ],
  },
  commentList: {
    description: "Прочитать страницу комментариев задачи",
    details:
      "Возвращает комментарии с их постоянными ID и полным содержанием. Для адресного чтения используйте task comment get <задача> <ID>. Новые записи меняют поколение данных: при устаревшем курсоре начните список заново.",
    examples: [
      {
        description: "Прочитать обсуждение страницей",
        command: "relay task comment list PRODUCT-1 --limit 20",
      },
    ],
  },
  commentGet: {
    description: "Прочитать полный комментарий",
    details:
      "Аргументы: задача и постоянный ID комментария из task comment list. Возвращает сохранённый Markdown и сведения об авторе. Комментарий принадлежит указанной задаче и неизменяем.",
    examples: [
      {
        description: "Прочитать выбранный комментарий",
        command: "relay task comment get PRODUCT-1 comment-id",
      },
    ],
  },
  commentAdd: {
    description: "Опубликовать комментарий к задаче",
    details:
      "Обязательно непустое body через --body, --body-file или --input; title необязателен. Требуется автор, --if-revision не используется. Комментарий не меняет ревизию содержания задачи; повтор вызова создаёт новую запись. После потери ответа сначала проверьте task comment list.",
    examples: [
      {
        description: "Сохранить результат проверки",
        command:
          "relay task comment add PRODUCT-1 --body 'Повтор поиска после HTTP 503 сохраняет запрос. Проверено вручную.' --actor human",
      },
    ],
  },
  unlink: {
    description: "Снять обычную связь задач",
    details:
      "Аргументы: изменяемая задача и связанная задача. --if-revision принадлежит первой. Снимает информационную связь, сохраняя обе записи. Обязательные зависимости изменяются через task dependency remove.",
    examples: [
      {
        description: "Убрать информационную связь",
        command: "relay task unlink PRODUCT-1 PRODUCT-2 --if-revision 3 --actor human",
      },
    ],
  },
  link: {
    description: "Связать задачи без обязательной зависимости",
    details:
      "Аргументы: изменяемая задача и связанная задача. --if-revision принадлежит первой. Обычная связь не добавляет обязательство выполнения; для него используйте task dependency add. Самоссылка запрещена.",
    examples: [
      {
        description: "Сохранить информационную связь",
        command: "relay task link PRODUCT-1 PRODUCT-2 --if-revision 2 --actor human",
      },
    ],
  },
  fields: {
    title: "Однострочный заголовок конкретной работы обычным текстом; пустота и пробелы допустимы",
    description: "Полное описание задачи в Markdown: цель, основания, работа, границы и проверка",
    target: "Ключ или ID цели; полный набор целей задачи",
    board: "Ключ, slug, префикс или ID доски; при создании по умолчанию BOARD-PRODUCT",
    column: "Колонка",
    parent: "Ссылка на родительскую задачу",
    query: "Поиск по содержанию",
    searchIn: "title — ключ, ID и заголовок; all — также описание; по умолчанию all",
    productTarget: "Продуктовая цель с дочерними требованиями",
    completion: "unfinished — без done/cancelled; finished — только done/cancelled",
    readiness: "blocked — с блокерами старта; ready — колонка ready без блокеров",
    initialColumn: "Начальная колонка; по умолчанию inbox",
    dependency: "Ключ или ID обязательной задачи-зависимости",
    related: "Ключ или ID связанной задачи без обязательства выполнения",
    acceptanceCriteria:
      "JSON-массив {title, summary?, description?}: title — непустой однострочный текст, summary — краткая текстовая аннотация, description — полные условия и способ проверки в Markdown; новые критерии невыполнены",
    newBoard: "Новая доска",
    parentTask: "Родительская задача",
    dependencyTask: "Задача-зависимость",
    criterionId: "ID критерия",
    heading: "Непустой однострочный заголовок критерия обычным текстом; при добавлении обязателен",
    criterionSummary: "Краткая текстовая аннотация критерия приёмки",
    criterionDescription: "Полные условия и способ проверки критерия в Markdown",
    commentTitle:
      "Необязательный однострочный заголовок комментария обычным текстом; пустая строка допустима",
    commentBody: "Непустой Markdown комментария: обсуждение, результат или свидетельство проверки",
    commentId: "ID комментария",
  },
  invalidCommentTitle: "title должен быть строкой",
} as const;
