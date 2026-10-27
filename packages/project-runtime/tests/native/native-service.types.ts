import type { createServiceConfiguration, GitSyncSupervisorStatus } from "@relay/project-runtime";

/**
 * Конфигурация собственной регистрации, вычисленная публичным Runtime до её установки.
 */
export type NativeConfiguration = ReturnType<typeof createServiceConfiguration>;

/**
 * Supervisor, чья принадлежность и живой instance подтверждены health-ответом.
 */
export interface RunningSupervisor extends GitSyncSupervisorStatus {
  /* Живой PID, отдельно сопоставляемый с native manager. */
  readonly pid: number;
  /* Подтверждённый ID текущего экземпляра, а не предполагаемое значение из PID. */
  readonly instance: string;
}

/**
 * Проверенная текущая пользовательская сессия одноразового runner.
 */
export interface NativeSession {
  /* Домашний каталог настоящей учётной записи; служба устанавливается только здесь. */
  readonly userHome: string;
  /* UID POSIX или null на Windows. */
  readonly uid: number | null;
  /* DOMAIN\user на Windows; отсутствие для POSIX. */
  readonly userName?: string;
  /* Исходный ответ loginctl yes/no; null на остальных платформах. */
  readonly linger: string | null;
}

/**
 * Независимое наблюдение и аварийная уборка единственной регистрации native-fixture.
 * Готовность приложения отдельно подтверждается публичным health, не статусом manager.
 */
export interface NativeManager {
  /**
   * Проверяет точную регистрацию и принадлежность живого PID собственному executable/argv.
   */
  assertRegistered(pid: number): Promise<void>;
  /**
   * Проверяет отсутствие регистрации независимо от production service status и health.
   */
  assertAbsent(): Promise<void>;
  /**
   * Аварийно завершает зарегистрированный supervisor; восстановление обязан выполнить manager.
   */
  crash(pid: number): Promise<void>;
  /**
   * Снимает только свою регистрацию после отказа production cleanup, не скрывая исходный отказ.
   */
  emergencyRemove(): Promise<void>;
  /**
   * Завершает PID, принадлежность которого вызывающий только что подтвердил живым health.
   */
  killSupervisor(pid: number): Promise<void>;
}
