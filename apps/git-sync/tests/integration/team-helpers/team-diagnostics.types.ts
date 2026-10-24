import type { SyncProgress } from "../../../src/local/state.types";

/**
 * Последняя фаза одного участника и момент её начала по монотонным часам fixture.
 */
export interface TeamPhase {
  /* Фаза production engine; setup применяется до первого cycle. */
  readonly phase: SyncProgress["phase"] | "setup";
  /* ID конкретного engine run, null до первого запуска. */
  readonly attemptId: string | null;
  /* Начало фазы в миллисекундах от начала fixture. */
  readonly startedMs: number;
}

/**
 * Конечная агрегированная стоимость одной категории без хранения payload или всех вызовов.
 */
export interface TeamCost {
  /* Число завершённых операций/фаз. */
  count: number;
  /* Сумма длительностей; параллельные операции перекрываются, это не wall time. */
  elapsedMs: number;
  /* Ненулевые target exits или infrastructure failures; смысл exit определяет caller. */
  nonZero: number;
}

/**
 * Ограниченный хвост phase markers для локализации места отказа конечного сценария.
 */
export interface TeamPhaseMarker extends TeamPhase {
  /* Индекс независимой реплики; -1 означает общую подготовку fixture. */
  readonly replica: number;
}

/**
 * Сводка native Git trace2; bounded tail явно отмечается как частичный.
 */
export interface NativeGitCosts {
  /* Объём файла trace перед чтением. */
  readonly totalBytes: number;
  /* Прочитаны только последние ограниченные bytes, не весь сценарий. */
  readonly truncated: boolean;
  /* Не удалось разобрать полную JSON-строку; записи не используются как evidence. */
  invalidLines: number;
  /* Число root Git starts в прочитанном диапазоне, включая отдельные crash actors. */
  starts: number;
  /* Число root Git exits в прочитанном диапазоне. */
  exits: number;
  /* Внутренние Git durations из t_abs; subprocess timings отдельно не прибавляются. */
  readonly operations: Record<string, TeamCost>;
}
