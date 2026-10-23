import type { EntityRecord, PlanStage, WorkPlanRecord } from "@relay/contracts";

/**
 * Проверяемая проекция этапа: идентичность, название и упорядоченный состав задач.
 */
export type StageView = Pick<PlanStage, "id" | "title" | "taskIds">;

/**
 * Подготовленный план с единственным пустым этапом.
 */
export interface StagedPlanFixture {
  /* Сохранённый план; его ревизия защищает этапы и включения задач. */
  readonly plan: WorkPlanRecord;

  /* Единственный этап подготовленного плана без включённых задач. */
  readonly stage: StageView;
}

/**
 * Подготовленный двухэлементный состав для проверки CLI-страниц планирования.
 */
export interface PlanningPageScenario {
  /* Аргументы чтения состава без параметров страницы и формата. */
  readonly command: readonly string[];
  /* Ожидаемые адрес и ревизия владельца в data ответа. */
  readonly owner: Readonly<Record<string, unknown>>;
  /* Полные карточки в порядке включения, обратном порядку создания. */
  readonly items: readonly [EntityRecord, EntityRecord];
}
