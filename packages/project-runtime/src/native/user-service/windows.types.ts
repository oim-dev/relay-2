import type {
  NativeServiceStatus,
  ServiceConfiguration,
  UserServiceContext,
} from "./service.types";

/**
 * Единый бюджет quiesce, остановки task и передачи lifetime mutex приложения.
 */
export interface WindowsStopContext {
  /* Собственная регистрация одного home; её ownership проверен до первой мутации. */
  readonly config: ServiceConfiguration;
  /* Исходное окружение и AbortSignal вызова. */
  readonly environment: UserServiceContext;
  /* Монотонная граница stop-фазы в миллисекундах performance.now(). */
  readonly deadline: number;
  /* Исходный бюджет в миллисекундах для диагностики, без продления на отдельные шаги. */
  readonly timeoutMs: number;
}

/**
 * Этап stop-фазы для точного отказа до следующей native-операции.
 * wait-supervisor-lock — прежнее публичное имя фазы; фактически проверяется переданный lease приложения.
 */
export type WindowsStopPhase = "quiesce" | "wait-stopped" | "wait-supervisor-lock";

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
