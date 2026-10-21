/**
 * Поведение дочернего процесса после получения настоящего SQLite mutex.
 */
export type LockProcessMode = "hold" | "write";

/**
 * Проверенные аргументы отдельного процесса, участвующего в тесте локального mutex.
 */
export interface LockProcessArguments {
  /* Абсолютный путь изолированного JSON-файла текущего теста. */
  readonly path: string;
  /* hold ожидает второй барьер внутри блокировки, write сразу публикует запись. */
  readonly mode: LockProcessMode;
  /* Строковая метка участника, дописываемая в журнал при успешной публикации. */
  readonly actor: string;
}

/**
 * Минимальный JSON-журнал, на котором проверяется отсутствие потерянной записи.
 */
export interface ActorLog {
  /* Участники в порядке успешной публикации; пустой массив означает отсутствие записей. */
  readonly actors: readonly string[];
}

/**
 * Ожидание одной полной строки протокола дочернего процесса.
 */
export interface PendingProcessLine {
  /* Передаёт строку без завершающего перевода строки первому ожидающему потребителю. */
  readonly resolve: (line: string) => void;
  /* Завершает ожидание ошибкой процесса или закрытия протокола. */
  readonly reject: (error: Error) => void;
}
