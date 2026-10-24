/**
 * Независимые ожидания сценария смерти владельца, до аварийной очистки fixture.
 */
export type OwnerKillPhase = "tree-ready" | "owner-exit" | "tree-stop";

/**
 * Безопасная идентичность Linux-процесса без cmdline, путей и окружения.
 */
export interface ProcessIdentity {
  /* PID, прочитанный только из собственного ChildProcess или маркеров fixture. */
  readonly pid: number;
  /* Состояние procfs, включая Z/X для уже завершившегося процесса. */
  readonly state: string;
  /* Текущий родитель; позволяет увидеть усыновление subreaper. */
  readonly parent: number;
  /* Группа процесса позволяет проверить отделение от anchor. */
  readonly group: number;
  /* Идентификатор POSIX-сессии. */
  readonly session: number;
  /* Поле starttime из procfs в clock ticks; строка сохраняет точность. */
  readonly startTicks: string;
}

/**
 * Наблюдение одного известного PID; несовпадение startTicks показывает его переиспользование.
 */
export interface ProcessObservation {
  /* Наблюдаемый PID собственного дерева. */
  readonly pid: number;
  /* Первое увиденное starttime; null на других ОС или до успешного чтения. */
  readonly expectedStartTicks: string | null;
  /* Текущее Linux-состояние; null при исчезновении либо на других ОС. */
  readonly current: ProcessIdentity | null;
  /* Код ошибки чтения; null при успехе либо отсутствии Linux procfs. */
  readonly errorCode: string | null;
}

/**
 * Ограниченный снимок фазы; не управляет процессами и не меняет assertions сценария.
 */
export interface OwnerKillSnapshot {
  /* Ожидаемый барьер. */
  readonly phase: OwnerKillPhase;
  /* Прошедшее монотонное время наблюдения в миллисекундах. */
  readonly elapsedMs: number;
  /* Exit непосредственного owner; null до его завершения либо при signal. */
  readonly ownerExitCode: number | null;
  /* Сигнал завершения owner; null до его завершения либо при обычном exit. */
  readonly ownerSignal: string | null;
  /* Нормализованный code/reason результата runGuardedCommand; null до его публикации. */
  readonly ownerResult: string | null;
  /* Наличие фиксированного набора маркеров; содержимое owner.json сюда не попадает. */
  readonly markers: Readonly<Record<string, boolean>>;
  /* Native-коды неудачного spawn branch/leaf; пустой массив означает отсутствие таких маркеров. */
  readonly spawnErrors: readonly string[];
  /* Известные процессы, включая anchor/guardian при доступном родстве. */
  readonly processes: readonly ProcessObservation[];
}
