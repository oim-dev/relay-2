/**
 * Проверенная общая часть карточки из JSON-ответа поставляемого бинарника.
 * Предметные поля содержания проверяются непосредственно в маршруте.
 */
export interface RecordResult {
  /* Постоянный ID записи внутри выбранного проекта. */
  readonly id: string;
  /* Текущий читаемый ключ записи. */
  readonly key: string;
  /* Положительная целая ревизия содержания для следующей команды записи. */
  readonly revision: number;
  /* Содержание карточки; значения на границе JSON ещё требуют предметной проверки. */
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Результат завершённого процесса CLI с полностью прочитанными потоками.
 */
export interface ProcessResult {
  /* Код завершения дочернего процесса. */
  readonly code: number;
  /* Полный stdout без нормализации пробелов и переводов строк. */
  readonly stdout: string;
  /* Полный stderr без нормализации. */
  readonly stderr: string;
}

/**
 * Изолированное окружение одного сквозного маршрута.
 * Вызывающий код обязан выполнить close в finally, в том числе при падении проверки.
 */
export interface WorkflowEnvironment {
  /* Уникальный каталог маршрута под .artifacts с отдельным домашним каталогом. */
  readonly root: string;
  /* Абсолютный путь собранной CLI для самостоятельного foreground-процесса fixture. */
  readonly binary: string;
  /* Изолированные переменные дочерних процессов; по умолчанию PATH пуст. */
  readonly variables: Readonly<Record<string, string>>;

  /**
   * Запускает новый бинарник в указанном каталоге и ожидает его завершения.
   * stdin отсутствует, если не передан; процесс ограничен deadline и завершается при очистке.
   */
  invoke(cwd: string, argv: readonly string[], stdin?: string): Promise<ProcessResult>;

  /**
   * Удаляет окружение маршрута после завершения всех его команд.
   */
  close(): Promise<void>;
}
