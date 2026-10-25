/**
 * Явные часы lifecycle: production использует реальные таймеры, проверки управляют событиями.
 * Интервалы задаёт shutdown, caller не меняет production grace/deadline через окружение.
 */
export interface ShutdownClock {
  /* Планирует callback через delayMs; возвращённая функция идемпотентно отменяет таймер. */
  readonly schedule: (delayMs: number, callback: () => void) => () => void;
}
