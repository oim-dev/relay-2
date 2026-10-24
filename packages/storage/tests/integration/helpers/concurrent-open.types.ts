import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Результат отдельного opener после закрытия всех его потоков.
 */
export interface OpenProcessResult {
  /* Код завершения; null при завершении сигналом. */
  readonly code: number | null;
  /* Сигнал завершения либо null после штатного exit. */
  readonly signal: NodeJS.Signals | null;
  /* Протокол ready + один JSON результата. */
  readonly stdout: string;
  /* Неожиданные ошибки отдельного процесса. */
  readonly stderr: string;
}

/**
 * Жизненный цикл изолированного opener; вызывающий выпускает stdin-barrier и завершает child в finally.
 */
export interface ConcurrentOpenProcess {
  /* Собственный процесс без потомков. */
  readonly child: ChildProcessWithoutNullStreams;
  /* Импорты загружены, БД ещё не открыта. */
  readonly ready: Promise<void>;
  /* Завершение вместе со stdout/stderr. */
  readonly result: Promise<OpenProcessResult>;
}
