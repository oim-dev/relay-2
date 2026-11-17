import type { Subprocess } from "bun";
import type { WorkerResult } from "./worker.types";

/**
 * Ready-барьер ребёнка после установки настоящего native-наблюдения.
 */
export interface ParentObservationReady {
  /* Постоянная фаза протокола перед проверяемым завершением родителя. */
  readonly phase: "ready";
  /* PID именно наблюдающего ребёнка, а не внешнего wrapper. */
  readonly observerPid: number;
  /* PID непосредственного родителя, захваченный ребёнком до ожидания. */
  readonly parentPid: number;
  /* Состояние сигнала до проверяемого действия; живой родитель не должен давать abort. */
  readonly aborted: boolean;
}

/**
 * Собственный процесс fixture с непрерывным чтением stdout/stderr.
 */
export interface ParentObservationWorker {
  /* Внешний wrapper либо короткий наблюдатель; stdin не используется как lease. */
  readonly child: Subprocess<"ignore", "pipe", "pipe">;
  /* Барьер действительного старта наблюдателя; ранний exit или неверный JSON дают ошибку. */
  readonly ready: Promise<ParentObservationReady>;
  /* Exit внешнего процесса и оба полностью дочитанных потока, включая inherited pipes ребёнка. */
  readonly result: Promise<WorkerResult>;
}
