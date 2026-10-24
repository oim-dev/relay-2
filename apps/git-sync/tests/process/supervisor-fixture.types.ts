import type { ControlEndpoint } from "../../src/local/control.types";

/**
 * Явно подготовленный тестом foreground S; stop ждёт его дерево до удаления HOME.
 */
export interface TestSupervisor {
  /* Подтверждённая идентичность S; capability не выводится в журналы. */
  readonly endpoint: ControlEndpoint;
  /* Идемпотентный graceful shutdown с bounded guardian fallback. */
  stop(): Promise<void>;
}
