/**
 * Справка и диагностика единственного пользовательского входа в Git Sync.
 */
export const gitSyncCommandMessages = {
  group: {
    description: "Git-синхронизация локальных данных проекта",
    details:
      "При обмене используется текущий origin Git-репозитория проекта и ветка relay-data в linked worktree data/ рядом с проектной SQLite внутри RELAY_HOME. Все worktree одного репозитория используют общее хранилище проекта. Созревший debounce подхватывает очередное предметное обращение CLI/Web; постоянный процесс не требуется. now выполняет явный обмен без задержки, status показывает локально известный исход.",
    examples: [
      {
        description: "Подключить и синхронизировать проект",
        command: "relay git-sync now\nrelay git-sync status",
      },
    ],
  },
  connect: {
    description: "Подключить remote и ветку данных",
    details:
      "--remote принимает origin, URL или путь Git-репозитория. Ветка по умолчанию relay-data. Origin наследуется из Git выбранного проекта; явный URL сохраняется как подключение. Connect проверяет ветку без публикации и импорта. В workspace укажите --project.",
    examples: [
      {
        description: "Подключить origin",
        command: "relay git-sync connect --remote origin --branch relay-data",
      },
    ],
  },
  status: {
    description: "Состояние одноразового обмена и локальной очереди",
    details:
      "Без --refresh читает локально известное состояние; неизвестные счётчики сохраняют null в JSON. --refresh обновляет сведения remote отдельной операцией с requestId. --wait-ms задаёт ожидание этой операции, а --refresh --request-id ID только ждёт прежний исход без нового submit. Параметры ожидания требуют --refresh; requestId адресует только выбранный проект.\n\nИз корня workspace без --project показывается каждая регистрация, включая недоступные; --all выбирает все явно. При --refresh --all у каждой регистрации собственный requestId и отдельный wait budget. Ошибка одного проекта не скрывает остальные, но общий код завершения ненулевой. --all несовместим с --project и с ожиданием одного --request-id.",
    examples: [
      {
        description: "Проверить весь workspace",
        command: "relay git-sync status --all --format json",
      },
    ],
  },
  now: {
    description: "Выполнить один обмен сейчас",
    details:
      "Без --request-id отправляет новый запрос обмена, обходя debounce и manual-режим. Параллельный обмен ждёт освобождения владельца. Runtime назначает operationId до запуска компонента. --request-id ID только ждёт прежний исход и не отправляет новую операцию. --wait-ms: 1–90000 мс, по умолчанию 60000.\n\nОдин обмен рассматривает ограниченное окно очереди. pending.changesets показывает фактический остаток, publication.window.deferred — ожидавшие зависимости ID этого окна, hasMore — наличие следующих пакетов при подготовке. Успех окна не обещает доставку всей очереди. Следующий now продолжает cursor; auto подхватывает продолжение при очередном обращении CLI/Web.\n\nGIT_SYNC_WAIT_TIMEOUT (код 4) сохраняет requestId и queued/running state: проверьте git-sync request get ID или продолжите ожидание now --request-id ID. Runtime process timeout (GIT_SYNC_TIMEOUT, код 124) сохраняет ID с state:unknown. GIT_SYNC_OUTCOME_UNKNOWN (код 4) означает потерю/истечение достоверного исхода, а не успех или отсутствие эффектов.\n\nНеразрешённые конфликты дают exit 4 / SYNC_CONFLICT; pending из-за budget или dependencies сам по себе этой ошибкой не является. Сетевой отказ не отменяет ранее сохранённые локальные изменения.",
    examples: [
      { description: "Синхронизировать выбранный проект", command: "relay git-sync now" },
      {
        description: "Ограничить ожидание и получить requestId в JSON",
        command: "relay git-sync now --wait-ms 5000 --format json",
      },
      {
        description: "Продолжить ожидание прежнего запроса без повторного submit; подставьте ID",
        command: "relay git-sync now --request-id request-id --wait-ms 60000",
      },
    ],
  },
  request: {
    description: "Исходы явных запросов обмена",
    details:
      "Проверяйте requestId из результата now/status --refresh или details ошибки. request get читает сохранённый/live outcome без Git и без повторного запуска операции. Используйте тот же проект и RELAY_HOME.",
    examples: [
      {
        description: "Проверить ранее выданный ID",
        command: "relay git-sync request get request-id --format json",
      },
    ],
  },
  requestGet: {
    description: "Прочитать исход по requestId без Git и submit",
    details:
      "Возвращает state: queued, running, completed, failed или unknown. Код 0 означает успешное чтение состояния; успех самой операции обозначает только completed. У failed сохраняется исходная error. unknown после потери owner или expiry не означает success/cancel и не запускает операцию повторно.\n\nЖурнал ограничен: до 64 активных и 128 недавних результатов, retention 15 минут; auto polling не журналируется. Для продолжения ожидания известного ID используйте now --request-id ID. При unknown решение о новой попытке принимается отдельно.",
    examples: [
      {
        description: "Прочитать состояние запроса",
        command: "relay git-sync request get request-id --format json",
      },
    ],
  },
  auto: {
    description: "Автоматический обмен проекта",
    details:
      "Новые проекты сохраняют режим в SQLite. Enable разрешает ленивый обмен при предметных обращениях CLI/Web; disable запрещает автоматические попытки, включая работу до появления origin. Чтения не продлевают debounce. Без следующего обращения отложенная доставка не запускается; now остаётся явным запросом.",
    examples: [
      { description: "Включить автоматический обмен", command: "relay git-sync auto enable" },
    ],
  },
  autoEnable: {
    description: "Включить обмен при обращениях CLI/Web",
    details:
      "Сохраняет auto в SQLite выбранного проекта. Созревшую попытку выполнит следующее предметное обращение CLI/Web. Настройка доступна и до появления origin.",
    examples: [{ description: "Включить обмен", command: "relay git-sync auto enable" }],
  },
  autoDisable: {
    description: "Отключить автоматический обмен проекта",
    details:
      "Сохраняет отключённый автоматический режим; локальные данные и remote остаются доступными для git-sync now.",
    examples: [{ description: "Отключить обмен", command: "relay git-sync auto disable" }],
  },
  conflicts: {
    description: "Просмотр и разрешение конфликтов",
    details:
      "list возвращает отдельно conflicts и blocked. get показывает стороны конфликта либо причину ожидания dependencies. resolve принимает согласованное решение действительного конфликта как JSON и обязательного автора.",
    examples: [{ description: "Посмотреть конфликты", command: "relay git-sync conflicts list" }],
  },
  conflictsList: {
    description: "Перечислить конфликты проекта",
    details:
      "Возвращает объект {conflicts: [...], blocked: [...]}. conflicts содержит действительные конфликты с fingerprint; blocked — ожидающие зависимости changeset со state: pending, причиной REPLICATION_DEPENDENCY и непосредственными dependencies. Это отдельная полная диагностика; пустой conflicts не обещает пустую очередь. Подробнее: get <id>.",
    examples: [{ description: "Список конфликтов", command: "relay git-sync conflicts list" }],
  },
  conflictsGet: {
    description: "Прочитать материалы конфликта",
    details:
      "ID берётся из conflicts list. Для действительного конфликта возвращает стороны и fingerprint. Для blocked ID объясняет state: pending, REPLICATION_DEPENDENCY и dependencies без fingerprint: дождитесь принятия предшественников и продолжите обмен. Такой пакет не требует resolve.",
    examples: [
      {
        description: "Материалы выбранного конфликта",
        command: "relay git-sync conflicts get conflict-id",
      },
    ],
  },
  conflictsResolve: {
    description: "Применить согласованное решение конфликта",
    details:
      '--input принимает JSON, @UTF-8-файл или - для stdin. Обязательные поля решения: fingerprint из последнего conflicts get <id> и choice: "local" либо "remote". Выбор относится ко всему конфликтующему пакету изменений, а не к одному полю. Требуется --actor либо RELAY_ACTOR. Устаревший fingerprint отклоняется без подстановки актуального; перечитайте конфликт и согласуйте решение заново. blocked ID без сторон отклоняется как REPLICATION_DEPENDENCY без сохранения решения. Успешное resolve сохраняет решение, но не подтверждает доставку: затем выполните git-sync now. Ответ показывает все оставшиеся conflicts и blocked, фактический pending и ограниченный preview included/deferred/hasMore.',
    examples: [
      {
        description: "Применить подготовленное решение",
        command:
          "relay git-sync conflicts resolve conflict-id --input @resolution.json --actor human",
      },
      {
        description: "Выбрать локальный вариант (подставьте ID и прочитанный fingerprint)",
        command:
          'relay git-sync conflicts resolve conflict-id --input \'{"fingerprint":"прочитанный-fingerprint","choice":"local"}\' --actor human',
      },
    ],
  },
  restore: {
    description: "Восстановить реплику или завершить сохранённую привязку",
    details:
      "Обычный restore в новом каталоге принимает --remote URL/путь и при необходимости --branch. Предварительный connect и локальная БД не нужны. Без --remote используется сохранённое подключение. Существующая рабочая БД не заменяется; конфиг с совпадающим ID и отсутствующей БД можно восстановить явно.\n\nПосле RESTORE_RECOVERY_REQUIRED явный --resume завершает привязку сохранённой локальной БД и сохраняет позднейшие принятые записи. Этот режим использует локальный intent, не выполняет fetch/материализацию и несовместим с --remote/--branch. --project-id передаёт постоянный ID проекта; без выбранного существующего config он обязателен. При existing config Runtime может выбрать ID самостоятельно; --project остаётся именем регистрации workspace. --project-id используется только с --resume.\n\nУспех resume возвращает resumed:true, preservedExisting:true и sourceCheckpoint:null: подтверждена локальная привязка, новый Git HEAD не заявляется. recovery содержит сведения о незавершённой private cleanup при успешной привязке. Повтор после полного завершения даёт RESTORE_NOT_PENDING (код 3); неподтверждённое или повреждённое намерение сохраняется с явным recovery-отказом. Дальнейшие connect/now запускаются отдельно.",
    examples: [
      {
        description: "Получить реплику из ветки данных",
        command:
          "relay git-sync restore --remote https://example.org/team/project.git --branch relay-data",
      },
      {
        description: "Завершить сохранённую привязку без config; подставьте ID из recovery details",
        command: "relay git-sync restore --resume --project-id project-id",
      },
      {
        description: "Завершить привязку проекта существующего config",
        command: "relay git-sync restore --resume --config ./relay.config.json",
      },
    ],
  },
  remote: "Origin, URL или путь Git-репозитория",
  branch: "Ветка данных; по умолчанию relay-data",
  resume: "Явно завершить привязку сохранённой БД по локальному intent, без fetch",
  resumeProjectId: "Постоянный ID для --resume; без existing config обязателен",
  resumeSourceConflict:
    "--resume несовместим с --remote и --branch: выберите сохранённый intent либо новый Git restore",
  projectIdRequiresResume: "--project-id применяется только вместе с --resume",
  resumeProjectIdEmpty: "--project-id должен быть непустым постоянным ID проекта",
  resumeBooleanRequired: "--resume принимает логическое значение",
  /**
   * Сообщает о неверной форме отдельного строкового аргумента restore без преобразования значения.
   */
  restoreTextRequired: (name: string): string => `--${name} должен содержать строку`,
  refresh: "Обновить сведения remote перед чтением статуса",
  requestId: "ID прежнего запроса из ответа или error.details.requestId; нового submit не создаёт",
  waitMs:
    "Ожидание исхода: 1–90000 мс, по умолчанию 60000; истечение не доказывает отсутствие эффектов",
  requestIdRequired: "--request-id должен быть непустым ID прежнего запроса",
  invalidWaitMs: "--wait-ms должен быть целым числом от 1 до 90000 миллисекунд",
  waitRequiresRefresh: "--request-id и --wait-ms для status требуют --refresh",
  waitRequiresProject:
    "Для ожидания одного --request-id выберите проект через --project; --all не подходит",
  /**
   * Сохраняет исходную диагностику и делает correlation видимой также в обычном текстовом stderr.
   */
  requestFailure: (message: string, id: string): string => `${message} ID запроса: ${id}.`,
  all: "Все регистрации выбранного workspace",
  id: "Постоянный ID changeset из conflicts или blocked в conflicts list",
  input: "JSON решения, @UTF-8-файл либо - для stdin",
  inputRequired: "Передайте --input: JSON, @файл либо -",
  filePathRequired: "После @ требуется путь файла решения",
  inputTooLarge: "Решение конфликта превышает 8 MiB",
  /**
   * Сохраняет исходную причину отказа чтения пользовательского JSON.
   */
  inputReadFailed: (cause: string): string => `Не удалось прочитать решение конфликта: ${cause}`,
  partialStatus: "Часть регистраций workspace недоступна; все исходы сохранены в результате",
  allAndProject: "--all нельзя использовать вместе с --project",
  unknown: "неизвестно",
  syncHeading: "Синхронизация",
  workerHeading: "Процесс worker",
  noProjects: "В workspace нет зарегистрированных проектов",
  statusLabels: {
    projectId: "Проект",
    databaseIdentity: "Локальная база",
    remote: "Remote",
    branch: "Ветка данных",
    connected: "Подключение",
    auto: "Автоматический обмен",
    autoEnabled: "Автоматический обмен",
    worker: "Процесс worker",
    request: "Текущий обмен",
    sync: "Синхронизация",
    phase: "Фаза обмена",
    attemptId: "Попытка обмена",
    lastFetch: "Последний fetch",
    lastSuccess: "Последний успешный обмен",
    lastAttempt: "Последняя попытка",
    nextRetry: "Следующая попытка",
    nextAttempt: "Назначенная попытка",
    ahead: "Исходящие Git-коммиты",
    behind: "Входящие Git-коммиты",
    localHead: "Локальный HEAD",
    remoteHead: "Наблюдаемый remote HEAD",
    localOnly: "Только локально",
    unpublished: "Не опубликовано",
    conflicts: "Конфликты",
    blocked: "Ожидают зависимостей",
    dependencies: "Непринятые предшественники",
    fingerprint: "Fingerprint сторон для resolve",
    publication: "Обход очереди публикации",
    window: "Последнее ограниченное окно",
    afterSequence: "Исходный cursor",
    nextSequence: "Cursor следующего окна",
    hasMore: "При подготовке оставались следующие пакеты",
    examined: "Рассмотрены ID",
    included: "Подготовлены ID",
    deferred: "Ожидали dependencies в этом окне",
    sourceBytes: "Исходные JSON, байт",
    oversized: "Одиночный пакет превышает byte budget",
    completed: "Исход окна установлен",
    error: "Ошибка",
    code: "Код",
    message: "Причина",
    operation: "Операция",
    at: "Время",
    reason: "Основание",
    details: "Подробности",
    state: "Состояние",
    installed: "Служба установлена",
    startup: "Условия запуска",
    configPath: "Конфигурация",
    home: "Данные",
    id: "ID",
    platform: "Платформа",
    managerExitCode: "Код системного менеджера",
    supervisor: "Отзывчивость supervisor",
    release: "Выпуск компонента",
    pid: "PID процесса",
    requestId: "ID запроса",
    operationId: "ID новой операции",
    acceptedAt: "Принят",
    startedAt: "Начат",
    action: "Действие",
    completedAt: "Завершён",
    result: "Сохранённый результат",
    desiredRegistration: "Желаемая регистрация",
    registered: "Зарегистрирована в менеджере",
    enabled: "Автозапуск менеджера",
    replicaId: "Реплика",
    mode: "Режим",
    git: "Git-коммиты",
    pending: "Ожидающие изменения",
    changesets: "Не подтверждены публикацией",
    oldest: "Самое раннее изменение",
    oldestAgeMs: "Возраст старейшего пакета, мс",
    unexported: "Ещё не экспортированы",
    desired: "Желаемое состояние",
    actual: "Фактическое состояние",
    responsive: "Отвечает на проверку готовности",
    version: "Версия",
    protocolVersion: "Версия протокола",
    binaryVersion: "Версия бинарника",
    instance: "Экземпляр процесса",
    started: "Время запуска",
    heartbeat: "Последний ответ",
    count: "Количество",
    freshness: "Актуальность",
    asOf: "По состоянию на",
    known: "Наблюдение remote известно",
  },
} as const;
