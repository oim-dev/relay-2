import type { TaskRecord, WorkPlanRecord } from "@relay/contracts";

/**
 * Два независимых владельца transfer с одной включённой исходной задачей.
 */
export interface TransferVersionFixture {
  /* Исходный открытый план с включённой задачей. */
  readonly source: WorkPlanRecord;
  /* Целевой открытый план с пустым этапом. */
  readonly target: WorkPlanRecord;
  /* Постоянный ID целевого этапа, принадлежащего target. */
  readonly targetStage: string;
  /* Задача сохраняется при отказах и успешном переносе включения. */
  readonly task: TaskRecord;
}
