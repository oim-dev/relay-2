import type { CommandHelp } from "../../output/help.types";

/**
 * Справка атомарных пакетов; каталог имён поступает от владельца операций Core.
 */
export const batchCommandMessages = {
  input: "JSON пакета, @путь к UTF-8 файлу или «-» для stdin; не более 8 МиБ",
  operationKey: "Ключ операции в выбранном проекте; обязателен для применения",
  check: "Проверить весь пакет с откатом, без квитанции и расходования ключа",
  return: "Добавить полные итоговые сущности к компактной квитанции",
  inputRequired: "Передайте пакет через --input: JSON, @путь или «-»",
  operationKeyRequired:
    "Для применения пакета требуется --operation-key; для проверки используйте --check",
  filePathRequired: "После @ в --input требуется путь к UTF-8 файлу",
  /**
   * Сохраняет исходную причину отказа файла либо stdin в диагностике источника.
   */
  readFailed: (reason: string): string => `Не удалось прочитать источник --input: ${reason}`,
  inputTooLarge: "Ввод --input превышает 8 МиБ",
  inputHeading: "  input:",
  emptyInput: "  input: {} — пустой объект, полей нет",
  fieldFormats: {
    scope: "JSON-массив {kind, id}",
    operator: "JSON-объект",
  },
  /**
   * Подписывает действие из предметного каталога без собственного перечня операций.
   */
  operationCode: (op: string): string => `Операция: ${op}`,
  /**
   * Объясняет форму адреса основного объекта и назначение из предметной команды.
   */
  reference: (description: string | null): string =>
    description === null
      ? "  ref: не принимается"
      : `  ref: string | {"$ref":string} — обязательно. ${description}; адрес или ссылка на локальное имя результата`,
  /**
   * Связывает локальную ревизию с владельцем CAS и условием переносимой альтернативы.
   */
  revision: (owner: string | null): string =>
    owner === null
      ? "  ifRevision: не принимается"
      : `  ifRevision: positive integer | {"$revision":string} — обязательно, если expectedVersion не передан; владелец: ${owner}. Положительное целое число прочитанной локальной ревизии либо локальное имя предыдущего результата того же владельца`,
  /**
   * Описывает непрозрачный переносимый токен того же владельца, отдельно от локальной CAS-ревизии.
   */
  expectedVersion: (owner: string | null): string =>
    owner === null
      ? "  expectedVersion: не принимается"
      : `  expectedVersion: string — обязательно, если ifRevision не передан; владелец: ${owner}. Непустой непрозрачный переносимый токен versions.aggregateVersion из versioned read владельца через readVersionedEntity(db.commands, ref, kind?) либо CommandExecutor.readVersioned; запись и версии относятся к одному anchor. Если переданы оба предусловия, проверяются оба, включая no-op`,
  /**
   * Выводит canonical имя, JSON-формат и назначение одного поля input.
   */
  field: (name: string, format: string, description: string): string =>
    `    ${name}: ${format} — ${description}`,
  /**
   * Показывает правило обязательности из предметного policy выбранной операции.
   */
  fieldPresence: (presence: string): string => `      Наличие: ${presence}`,
  /**
   * Объясняет пропуск поля отдельно от его явно переданного значения.
   */
  fieldOmission: (omission: string): string => `      ${omission}`,
  /**
   * Показывает смысл null только для допускающего его поля.
   */
  fieldNull: (meaning: string): string => `      null: ${meaning}`,
  /**
   * Сохраняет точные адресные пути вложенных локальных ссылок из Core.
   */
  referenceFields: (paths: readonly string[]): string =>
    `  Поля input с поддержкой $ref: ${paths.join(", ")}`,
  /**
   * Представляет только объявленные владельцем допустимые значения enum.
   */
  enumFormat: (values: readonly (string | number)[]): string =>
    `enum (${values.map((value) => JSON.stringify(value)).join(" | ")})`,
  /**
   * Уточняет альтернативное имя того же поля предметного JSON.
   */
  fieldAlias: (description: string, alias: string): string =>
    `${description}; альтернативное имя поля ${alias}`,
  /**
   * Объясняет локальную ссылку для адресного scalar, сохраняя ограничения обычного адреса владельца.
   */
  fieldReference: (description: string): string =>
    `${description}; допускается локальная ссылка {"$ref":"имя"} на предыдущий результат`,
  /**
   * Отличает массив адресов от повторяемого параметра отдельной CLI-команды.
   */
  fieldReferenceList: (description: string): string =>
    `${description}; JSON-массив строковых ссылок или {"$ref":"имя"} на предыдущие результаты`,
  fieldDescriptions: {
    acceptedSessionIds:
      "Ссылки на принимаемые завершённые (completed) прямые дочерние сессии исходного намерения: ID, ключи, алиасы или типизированные ссылки",
    stageDirection: "Перемещение этапа на одну позицию вверх или вниз",
    stageBefore:
      "ID этапа того же плана либо локальная ссылка на этап, перед которым разместить текущий",
    /**
     * Описывает JSON-форму области плана, отличающуюся от строковых сокращений CLI.
     */
    scope: (kinds: readonly string[]): string =>
      `Область воздействия плана: массив объектов {kind,id}, например [{"kind":"feature","id":"FEATURE-1"}]. kind: ${kinds.join(" | ")}; id — адрес записи или {"$ref":"имя"}. Переданный массив заменяет прежнюю область`,
    /**
     * Раскрывает объект operator без несуществующих отдельных полей или подстановок окружения.
     */
    operator: (sources: readonly string[]): string =>
      `Сведения о пользователе участия: {name?:string|null,email?:string|null,source:string}. source: ${sources.join(" | ")}. Значения передаются в самом объекте operator`,
    /**
     * Дополняет назначение ревизии формой локального результата пакета.
     */
    targetRevision: (description: string): string =>
      `${description}; положительное целое число либо {"$revision":"имя"} предыдущего результата, принадлежащего целевому плану`,
    targetVersion:
      "Непустой непрозрачный переносимый aggregateVersion целевого плана targetPlan из versioned read; используется альтернативно targetRevision или вместе с ним",
    /**
     * Уточняет состав JSON-отношений, их enum и типизированные адреса.
     */
    relations: (description: string, kinds: readonly string[], types: readonly string[]): string =>
      `${description}. target или target.id принимают локальную ссылку {"$ref":"имя"}; target.kind: ${kinds.join(" | ")}; type: ${types.join(" | ")}`,
  },
  /**
   * Показывает рассогласование каталога и зарегистрированных CLI-команд.
   */
  helpMissingCommand: (op: string): string => `Для справки batch не зарегистрирована команда ${op}`,
  /**
   * Указывает canonical поле без связанного CLI-аргумента или явного описания batch.
   */
  helpMissingArgument: (path: string): string =>
    `Для справки batch не найдено описание аргумента ${path}`,
  /**
   * Не позволяет опубликовать пустое назначение известного поля.
   */
  helpMissingDescription: (path: string): string =>
    `Для справки batch отсутствует назначение поля ${path}`,
  /**
   * Не допускает вымышленного JSON-типа для произвольного custom parser.
   */
  helpUnknownFormat: (path: string): string => `Для справки batch не определён формат поля ${path}`,
  /**
   * Отклоняет enum без опубликованного списка допустимых значений.
   */
  helpMissingChoices: (path: string): string =>
    `Для справки batch отсутствуют значения enum поля ${path}`,
  /**
   * Не допускает публикацию nullable-поля без объяснения смысла null от владельца policy.
   */
  helpMissingNullMeaning: (path: string): string =>
    `Для справки batch отсутствует смысл null поля ${path}`,
  helpRoot: {
    description: "Справка по предметным операциям batch",
    details:
      "Выберите предметный раздел из списка. Затем уточняйте путь отдельными словами: relay batch help plan stage create. Группы показывают только ближайшие действия и подгруппы; лист содержит JSON-контракт одной операции и пример пакета. Общий формат, проверка и применение: relay batch -h.",
    examples: [
      { description: "Посмотреть действия планирования", command: "relay batch help plan" },
    ],
  },
  /**
   * Формирует лёгкую навигацию выбранного раздела, не раскрывая поля операций.
   */
  helpGroup: (path: string, description: string, child: string): CommandHelp => ({
    description,
    details: `Выберите действие или подгруппу из списка. Для JSON-контракта дополняйте путь relay batch help ${path} отдельными словами. Все разделы: relay batch help. Общий формат и применение: relay batch -h.`,
    examples: [
      {
        description: "Открыть следующий уровень справки",
        command: `relay batch help ${path} ${child}`,
      },
    ],
  }),
  /**
   * Связывает подробности одного действия с его разделом и единственной командой выполнения.
   */
  operationNavigation: (parent: string): string =>
    `Другие действия раздела: relay batch help ${parent}. Общий формат и применение пакета: relay batch -h. Этот путь показывает справку; пакет выполняется через relay batch --input.`,
  operationExample:
    "Проверить пакет из одной операции; подставьте адреса и прочитанные ревизии своего проекта",
  /**
   * Общий формат выполнения; подробные поля доступны только в дереве batch help.
   */
  execute: {
    description: "Применить атомарный пакет предметных изменений",
    details:
      'Формат: {"version":1,"operations":[...]}, от 1 до 200 операций. --input принимает JSON, @путь к UTF-8 файлу относительно каталога запуска или «-» для stdin; предел 8 МиБ проверяется до открытия БД. Автор: --actor или RELAY_ACTOR.\n\nПрименение требует --operation-key. --check выполняет пакет с откатом без квитанции, ключ не требуется; автор нужен в обоих режимах. --return full добавляет итоговые записи к компактной квитанции.\n\nЛокальные результаты именуются через as: {"$ref":"имя"} в адресном поле использует предыдущий результат, {"$revision":"имя"} — локальную ревизию его владельца. Для изменения существующего владельца передайте ifRevision либо expectedVersion; можно передать оба, тогда проверяются оба. ifRevision — прочитанная локальная ревизия из get или {"$revision":"имя"}. expectedVersion — непустой непрозрачный переносимый token versions.aggregateVersion из Core API readVersionedEntity(db.commands, ref, kind?) либо CommandExecutor.readVersioned: entity и versions читаются одним anchor. Строки и Markdown не интерполируются, ссылки вперёд запрещены.\n\nОшибка операций откатывает пакет. Ошибка записи stdout после commit не отменяет сохранение: повторите прежний запрос с тем же --operation-key или выполните batch result <ключ>. Восстанавливается исходный результат, даже если записи уже изменились.\n\nТот же ключ, автор и запрос возвращают квитанцию; другой запрос конфликтует. Нормализация синтаксическая: пробелы вне JSON-строк и порядок полей объектов несущественны; массивы, строки, адреса, as и явно заданные поля существенны. Автор входит в идентичность запроса; --format и --return не входят.\n\nРазделы: relay batch help. Действия плана: relay batch help plan. Контракт одной операции: relay batch help plan stage create.',
    examples: [
      {
        description: "Создать новую редакцию и архивировать DOC-1; подставьте прочитанную ревизию",
        command: `relay batch --actor agent --operation-key publish-spec-v2 --input '{
  "version": 1,
  "operations": [
    {"op":"document.create","as":"new-spec","input":{"name":"Правила, редакция 2","body":"# Актуальная редакция"}},
    {"op":"document.update","ref":"DOC-1","ifRevision":3,"input":{"documentStatus":"archived"}}
  ]
}'`,
      },
    ],
  },
  result: {
    description: "Прочитать исходную квитанцию атомарного пакета",
    details:
      "Передайте ключ ранее применённого пакета в выбранном проекте. Возвращается исходный результат операции, а не текущие версии сущностей. По умолчанию квитанция компактная; --return full добавляет полные итоговые записи из сохранённого результата. Автор и входной пакет для чтения не требуются.",
    examples: [
      {
        description: "Прочитать сохранённую квитанцию",
        command: "relay batch result publish-spec-v2",
      },
      {
        description: "Получить полное содержание исходного результата",
        command: "relay batch result publish-spec-v2 --return full --format json",
      },
    ],
  },
} as const;
