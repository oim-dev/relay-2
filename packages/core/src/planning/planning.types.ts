import type { CommandWriteOptions, PlanStage } from "@relay/contracts";

/**
 * Клиентские условия обоих владельцев переноса. Каждая сторона требует числовой CAS
 * либо переносимую версию; при одном плане оба условия всё равно проверяются независимо.
 */
export interface PlanTransferWriteOptions extends Readonly<CommandWriteOptions> {
  /* Ожидаемая ревизия получателя; отсутствие допустимо только с targetVersion. */
  readonly targetRevision?: number;
  /* Переносимая версия агрегата получателя; проверяется вместе с CAS, если переданы оба. */
  readonly targetVersion?: string;
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
