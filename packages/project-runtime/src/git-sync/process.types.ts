/**
 * Явный запуск дочернего процесса; shell не участвует в интерпретации аргументов.
 */
export interface ProcessCommand {
  /* Абсолютный executable либо имя нативной утилиты из переданного PATH. */
  readonly executable: string;
  /* Уже разделённые аргументы, включая пути с пробелами и Unicode. */
  readonly args: readonly string[];
  /* Рабочий каталог только дочернего процесса. */
  readonly cwd: string;
  /* Полное окружение ребёнка, без неявного наследования process.env. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /* Доверенный helper с private ролью; исходный Bun использует entry Runtime, compiled embedding обязан передать. */
  readonly guardianComponent?: readonly string[];
  /* Текст единственного запроса; без stdinLease после него передаётся EOF. */
  readonly input?: string;
  /* Удерживает stdin как lease foreground-ребёнка до завершения/смерти родителя; по умолчанию false. */
  readonly stdinLease?: boolean;
  /* Deadline в миллисекундах; null разрешён только для foreground supervisor. */
  readonly timeoutMs: number | null;
  /* Отмена сохраняет SIGINT/SIGTERM в exit code; POSIX получает сигнал, Windows stdinLease — EOF. */
  readonly signal?: AbortSignal;
  /* Отвергает повреждённый UTF-8 машинного stdout; native-диагностика по умолчанию допускает замену. */
  readonly strictStdout?: boolean;
  /* Получатель потокового stdout; отсутствие включает ограниченное накопление. */
  readonly stdout?: (text: string) => void;
  /* Получатель потокового stderr; отсутствие включает ограниченное накопление. */
  readonly stderr?: (text: string) => void;
}

/**
 * Фактический исход native-процесса; ненулевой код сам по себе не является исключением runner.
 */
export interface ProcessResult {
  /* Код ОС либо 128 + номер завершающего сигнала. */
  readonly exitCode: number;
  /* Полный ограниченный stdout; при потоковой передаче пуст. */
  readonly stdout: string;
  /* Полный ограниченный stderr; при потоковой передаче пуст. */
  readonly stderr: string;
}

/**
 * Подменяемая граница запуска native managers и компонента, без глобальных изменений среды.
 */
export type ProcessRunner = (command: ProcessCommand) => Promise<ProcessResult>;
