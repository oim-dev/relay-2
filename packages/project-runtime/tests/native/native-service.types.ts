import type { createServiceConfiguration, GitSyncSupervisorStatus } from "@relay/project-runtime";

/**
 * Платформы отдельного набора, на которых проверяется настоящий user manager.
 */
export type NativePlatform = "linux" | "darwin" | "win32";

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
