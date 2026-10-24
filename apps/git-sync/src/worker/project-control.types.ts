import type { ControlEndpoint } from "../local/control.types";

/**
 * Команда supervisor, отделённая от жизненного цикла короткого request-component.
 */
export interface ProjectStartOptions {
  /* true запрашивает новый экземпляр; false/отсутствие допускает уже ready worker. */
  readonly restart?: boolean;
  /* auto меняет mode только после ready; отсутствие сохраняет актуальный режим. */
  readonly mode?: "auto";
}

/**
 * Одна принятая S команда на физическую базу; одинаковые start объединяются.
 */
export interface PendingProjectStart {
  /* Сигнатура restart/mode без credentials и других caller env. */
  readonly signature: string;
  /* Ответ только после readiness и успешного CAS предпочтений. */
  readonly promise: Promise<ControlEndpoint | null>;
}
