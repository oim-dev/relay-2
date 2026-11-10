import type { Database } from "bun:sqlite";
import { RelayError } from "@relay/contracts";
import { synchronizationMessages } from "./schedule.messages";
import type {
  SynchronizationAttempt,
  SynchronizationMode,
  SynchronizationSchedule,
} from "./schedule.types";

/**
 * Добавляет локальное расписание; существующая очередь после миграции доступна следующему обращению.
 */
export const SYNCHRONIZATION_SCHEMA = `
CREATE TABLE synchronization_schedule (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  mode TEXT NOT NULL DEFAULT 'auto' CHECK(mode IN ('auto','manual')),
  dirty_since INTEGER, last_mutation_at INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0)
) STRICT;
INSERT INTO synchronization_schedule(singleton,dirty_since,last_mutation_at)
VALUES(1,CASE WHEN EXISTS(SELECT 1 FROM replication_outbox) THEN 0 END,
         CASE WHEN EXISTS(SELECT 1 FROM replication_outbox) THEN 0 END);
`;

/**
 * Отмечает фактическое появление durable changeset в той же транзакции; rollback отменяет отметку.
 */
export function recordSynchronizationMutation(connection: Database, at: number): void {
  connection
    .query(
      `UPDATE synchronization_schedule
    SET dirty_since=coalesce(dirty_since,?1),last_mutation_at=?1 WHERE singleton=1`,
    )
    .run(at);
}

/**
 * Сбрасывает расписание технической инициализации при создании пустой реплики.
 * Вызывающий уже удалил начальный outbox в той же транзакции; к рабочей БД неприменимо.
 * Новая реплика начинает с auto независимо от политики источника; bootstrap/import режим не сбрасывают.
 */
export function resetSynchronizationSchedule(connection: Database): void {
  connection.exec(`UPDATE synchronization_schedule SET mode='auto',dirty_since=NULL,last_mutation_at=NULL,
    next_attempt_at=0,last_attempt_at=NULL,failures=0 WHERE singleton=1`);
}

/**
 * Читает одну техническую строку без outbox payload, карточек и Git.
 */
export function readSynchronizationSchedule(connection: Database): SynchronizationSchedule {
  const result = connection
    .query<SynchronizationSchedule, []>(
      `SELECT mode,
    dirty_since AS dirtySince,last_mutation_at AS lastMutationAt,
    next_attempt_at AS nextAttemptAt,last_attempt_at AS lastAttemptAt,failures
    FROM synchronization_schedule WHERE singleton=1`,
    )
    .get();
  if (result === null) {
    throw new RelayError("DATABASE_INVALID", synchronizationMessages.stateMissing, 1);
  }
  return result;
}

/**
 * Меняет только локальную политику в транзакции вызывающего, без outbox, generation и сброса backoff.
 * Тот же режим не выполняет UPDATE; неизвестное значение отклоняется как INVALID_ARGUMENT.
 */
export function setSynchronizationMode(connection: Database, mode: SynchronizationMode): void {
  if (mode !== "auto" && mode !== "manual") {
    throw new RelayError("INVALID_ARGUMENT", synchronizationMessages.invalidMode, 2);
  }
  connection
    .query("UPDATE synchronization_schedule SET mode=?1 WHERE singleton=1 AND mode!=?1")
    .run(mode);
}

/**
 * Сохраняет исход без changeset и обновления generation; поздние записи определяются живой очередью.
 */
export function completeSynchronizationAttempt(
  connection: Database,
  attempt: SynchronizationAttempt,
): void {
  if (
    ![attempt.at, attempt.nextAttemptAt].every((value) => Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new RelayError("INVALID_ARGUMENT", synchronizationMessages.invalidAttemptTime, 2);
  }
  connection
    .query(
      `UPDATE synchronization_schedule SET
    dirty_since=CASE WHEN EXISTS(SELECT 1 FROM replication_outbox) THEN dirty_since ELSE NULL END,
    last_attempt_at=?1,next_attempt_at=?2,failures=CASE WHEN ?3 THEN failures+1 ELSE 0 END
    WHERE singleton=1`,
    )
    .run(attempt.at, attempt.nextAttemptAt, Number(attempt.failed));
}
