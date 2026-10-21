import type { PlanStage, WriteOptions } from "@relay/contracts";

/**
 * Ревизии обоих владельцев переноса; для одного плана проверяются обе переданные ревизии.
 */
export interface PlanTransferWriteOptions extends Readonly<WriteOptions> {
  /* Ожидаемая ревизия целевого плана; ifRevision защищает исходный план. */
  readonly targetRevision: number;
}

/**
 * Единственное включение, которое допустимо сохранить при проверке конфликта состава.
 */
export interface AllowedTaskMembership {
  /* Постоянный ID открытого плана в текущем проекте. */
  readonly planId: string;
  /* Постоянный ID этапа внутри указанного плана. */
  readonly stageId: string;
}

/**
 * Направление изменения явного включения задачи в этап.
 */
export type StageTaskAction = "include" | "remove";

/**
 * Новые составы переноса; при переносе внутри одного плана оба поля содержат один массив.
 */
export interface TransferredPlanStages {
  /* Упорядоченные этапы исходного плана после исключения задачи. */
  readonly source: PlanStage[];
  /* Упорядоченные этапы целевого плана после включения задачи. */
  readonly target: PlanStage[];
}
