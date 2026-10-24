import type { NamedCommand, PortableProjectSnapshot, ReplicationChangeset } from "@relay/contracts";
import type { RepositoryOptions } from "../../../src/transport/repository.types";

/**
 * Durable-граница непосредственного process.exit при незакрытом соединении SQLite.
 */
export type ExchangeCrashPoint = "before-push" | "after-push" | "after-accept";

/**
 * Один запуск production engine в отдельном процессе; complete выполняет обычное восстановление.
 */
export interface ExchangeProcessAttempt {
  /* Точка аварии либо полный цикл нового владельца. */
  readonly point: ExchangeCrashPoint | "complete";
  /* Для after-accept: конкретный входящий HEAD; без него остановка относится к собственному push. */
  readonly acceptHead?: string;
  /* Одна конкурентная команда на отдельном SQLite-соединении после Git commit до push. */
  readonly lateCommand?: NamedCommand;
}

/**
 * Закрытый тестовый протокол stdin: пути принадлежат fixture, пользовательские remote запрещены.
 */
export interface ExchangeProcessInput extends ExchangeProcessAttempt {
  /* Уже созданная файловая БД; процесс открывает и при crash намеренно не закрывает её. */
  readonly databasePath: string;
  /* Существующий каталог progress/prepared этой реплики. */
  readonly directory: string;
  /* Параметры реального private Git без несериализуемого AbortSignal. */
  readonly repository: Omit<RepositoryOptions, "signal">;
}

/**
 * Наблюдение SQLite непосредственно на барьере; тест сравнивает его после нового открытия.
 */
export interface ExchangeDatabaseState {
  /* Переносимые данные, parts, тексты, receipt, comments и canonical versions. */
  readonly snapshot: PortableProjectSnapshot;
  /* Реальный SQLite accepted base; локальный Git candidate не заменяет его. */
  readonly base: PortableProjectSnapshot | null;
  /* Полные исходные immutable changesets, включая ID/digest и поздние записи. */
  readonly outbox: readonly ReplicationChangeset[];
  /* Поколение предметных данных для проверки отсутствия повторного импорта. */
  readonly generation: number;
  /* Локальные CAS всех владельцев по постоянным ID, в порядке ID. */
  readonly revisions: readonly (readonly [string, number])[];
}

/**
 * Свидетельство реально достигнутой границы; пишется синхронно перед аварийным выходом.
 */
export interface ExchangeProcessObservation {
  /* Достигнутая точка; complete означает успешное завершение engine.run. */
  readonly point: ExchangeProcessAttempt["point"];
  /* PID нового процесса, отличного от test runner и соседних попыток. */
  readonly pid: number;
  /* Реальный кандидат push либо принимаемый HEAD при остановке входящего импорта. */
  readonly head: string;
  /* SQLite на входе push после фиксации поздней команды; null у чистого входящего приёма. */
  readonly beforePush: ExchangeDatabaseState | null;
  /* SQLite в момент аварии либо успешного завершения. */
  readonly state: ExchangeDatabaseState;
  /* Исходная поздняя транзакция до любого acceptance; null, если команда не назначалась. */
  readonly lateChange: ReplicationChangeset | null;
}
