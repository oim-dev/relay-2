/**
 * Локальная политика обмена: auto разрешает ленивые попытки, manual оставляет только явный now.
 * Не зависит от наличия remote/connection и не переносится между репликами.
 */
export type SynchronizationMode = "auto" | "manual";

/**
 * Локальное межпроцессное расписание обмена одной SQLite; в переносимый snapshot не входит.
 * dirtySince очищается завершением попытки при живой пустой очереди, а не самим ack.
 * Миграция непустой очереди без прежних отметок выставляет dirtySince/lastMutationAt в 0,
 * чтобы накопленные changeset были доступны следующему обращению без нового debounce.
 */
export interface SynchronizationSchedule {
  /* Локальная политика обмена; новая/мигрированная БД и createReplica начинают с auto. */
  readonly mode: SynchronizationMode;
  /* Начало текущей серии локальных записей в Unix ms; null до записи или после завершённой доставки. */
  readonly dirtySince: number | null;
  /* Последнее добавление changeset в Unix ms; чтения и импорт не меняют значение. */
  readonly lastMutationAt: number | null;
  /* Самое раннее время автоматической попытки в Unix ms; now обходит это условие. */
  readonly nextAttemptAt: number;
  /* Последняя завершённая попытка в Unix ms; null до первого обращения транспорта. */
  readonly lastAttemptAt: number | null;
  /* Число последовательных отказов обмена; успешная попытка обнуляет счётчик. */
  readonly failures: number;
}

/**
 * Завершение одной попытки под межпроцессным mutex транспорта; сеть уже закончена.
 * Обе отметки времени — неотрицательные безопасные целые числа миллисекунд Unix.
 */
export interface SynchronizationAttempt {
  /* Unix ms завершения; значение задаёт владелец часов сценария. */
  readonly at: number;
  /* Unix ms следующего допустимого автоматического обращения. */
  readonly nextAttemptAt: number;
  /* true означает отказ; отсутствие remote учитывается как успешная локальная проверка. */
  readonly failed: boolean;
}
