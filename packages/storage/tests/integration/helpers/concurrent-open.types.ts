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

/**
 * Наблюдаемые границы детерминированного WAL retry, без привязки к порядку metadata SQL.
 */
export type WalRetryEvent =
  "wal-busy" | "first-closed" | "fixture-replaced" | "reopened" | "wal-retry" | "retry-closed";

/**
 * Факты исполнения fault-injection на настоящих соединениях.
 */
export interface WalRetryTrace {
  /* Число вызовов WAL-перехода; первая попытка получает единственный искусственный BUSY. */
  readonly walAttempts: number;
  /* Число реально внедрённых ошибок SQLITE_BUSY. */
  readonly busyFailures: number;
  /* Число завершённых native close первого соединения. */
  readonly firstCloses: number;
  /* SELECT 1 на первом handle после native close действительно отклонён. */
  readonly closedHandleRejectsQuery: boolean;
  /* Число новых соединений к уже заменённому файлу, наблюдённых через SQLite query. */
  readonly reopens: number;
  /* Число закрытий повторных соединений до выхода проверяемой операции. */
  readonly retryCloses: number;
  /* Хронология видимых границ; вспомогательная finally-уборка сюда не попадает. */
  readonly events: readonly WalRetryEvent[];
}

/**
 * Результат синхронной операции и её наблюдения до снятия test-local spies.
 */
export interface WalRetryProbeResult<T> {
  /* Результат вызова публичного API либо проверенная ошибка, которую вернул callback теста. */
  readonly value: T;
  /* Факты первой попытки, закрытия и retry, которые тест обязан проверить явно. */
  readonly trace: WalRetryTrace;
}
