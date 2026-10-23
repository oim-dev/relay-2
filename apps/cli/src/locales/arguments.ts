/**
 * Справка и диагностики общих источников ввода CLI.
 */
export const argumentMessages = {
  revision: "Прочитанная ревизия изменяемого владельца (обязательно)",
  pageSize: "Размер страницы (1–100)",
  cursor: "Курсор продолжения того же запроса",
  reference: "Ключ, алиас или постоянный ID",
  inputFile: "JSON-файл полей; «-» читает stdin",
  invalidInputJson: "В --input ожидается корректный JSON",
  invalidUtf8: "Источник ввода содержит недопустимую последовательность байтов UTF-8",
  inputObjectRequired: "В --input ожидается JSON-объект",
  inputParserRequired: "Для --input не зарегистрирован разбор JSON-полей",
  sharedStdin: "stdin может использовать только одно поле",
  mixedInput: "--input/--input-file нельзя смешивать с отдельными полями",
  /**
   * Объясняет ограничение размера до накопления полного UTF-8 потока.
   */
  inputTooLarge: (maxBytes: number): string => `Ввод превышает ${maxBytes / (1024 * 1024)} МиБ`,

  /**
   * Помечает безусловно обязательный параметр, проверяемый парсером.
   */
  required: (description: string): string => `${description} (обязательно)`,

  /**
   * Дополняет описание повторяемого параметра правилом его передачи.
   */
  repeated: (description: string): string => `${description}; повторяйте параметр`,

  /**
   * Описывает включительные границы допустимого целого числа.
   */
  integerRange: (min: number, max: number): string => `ожидается целое число от ${min} до ${max}`,

  /**
   * Подписывает файловый UTF-8 источник именованного поля.
   */
  textFile: (name: string): string => `Текст --${name} из UTF-8 файла; «-» читает stdin`,

  /**
   * Перечисляет разрешённые поля цельного JSON-ввода в порядке схемы команды.
   */
  input: (allowed: readonly string[]): string =>
    `JSON-объект полей (${allowed.join(", ")}); несовместим с отдельными полями`,

  /**
   * Подписывает файловый JSON-источник именованного поля.
   */
  jsonFile: (name: string): string => `JSON-файл для ${name}; «-» читает stdin`,

  /**
   * Объясняет одновременную передачу двух имён одного предметного поля.
   */
  conflictingFields: (source: string, target: string): string =>
    `Поля ${source} и ${target} несовместимы`,

  /**
   * Объясняет одновременную передачу inline- и файлового источников поля.
   */
  conflictingSources: (field: string, file: string): string =>
    `Параметры --${field} и --${file} несовместимы`,

  /**
   * Сохраняет имя файлового параметра и исходную диагностику чтения.
   */
  readFailed: (key: string, message: string): string => `Не удалось прочитать --${key}: ${message}`,

  /**
   * Объясняет превышение ограничения размера одного файлового источника.
   */
  fileTooLarge: (key: string, mebibytes: number): string =>
    `Файл --${key} превышает ${mebibytes} МиБ`,

  /**
   * Указывает файловый источник с синтаксически неверным JSON.
   */
  invalidFileJson: (key: string): string => `В --${key} ожидается корректный JSON`,

  /**
   * Указывает обязательное непустое текстовое поле.
   */
  requiredText: (name: string): string => `Укажите непустое поле ${name}`,

  /**
   * Указывает первое поле, не предусмотренное схемой команды.
   */
  unknownField: (name: string): string => `Неизвестное поле: ${name}`,
} as const;
