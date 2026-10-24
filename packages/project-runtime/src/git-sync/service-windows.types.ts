import type { NativeServiceStatus } from "./service.types";

/**
 * Одно COM-наблюдение собственной задачи и её текущих экземпляров.
 * Счётчик нужен барьеру stop; он не расширяет публичную форму service status.
 */
export interface WindowsServiceSnapshot {
  /* Зарегистрированное состояние задачи, отдельное от readiness приложения. */
  readonly native: NativeServiceStatus;
  /* Число экземпляров GetInstances(0) в доступном security context текущего пользователя. */
  readonly runningInstances: number;
}
