import type {
  EntityPage,
  PlanOwner,
  ReleasePlans,
  ReleaseRecord,
  TaskRecord,
  WorkPlanRecord,
  TaskProgress,
} from "@relay/contracts";

/**
 * Запланированный релиз из двух завершённых планов с независимыми готовыми задачами.
 */
export interface CompletedPlanRelease {
  /* Первый завершённый план с двумя задачами. */
  readonly first: WorkPlanRecord;
  /* Второй завершённый план с одной задачей. */
  readonly second: WorkPlanRecord;
  /* Релиз с обоими планами в указанном порядке, ещё не опубликованный. */
  readonly release: ReleaseRecord;
}

/**
 * Минимальный состав этапа либо релиза для проверки ограниченных страниц.
 */
export interface PlanningPageFixture {
  /* Владелец с сохранённым порядком включения; у плана один этап. */
  readonly owner: WorkPlanRecord | ReleaseRecord;
  /* Полные карточки в порядке включения, намеренно отличном от порядка ключей. */
  readonly items: readonly (TaskRecord | WorkPlanRecord)[];
}

/**
 * Метаданные владельца для общих проверок страниц двух составов.
 */
export type PlanningPageOwner = PlanOwner | Omit<ReleasePlans, "items">;

/**
 * Общая форма результата страницы для сравнения карточек и метаданных в табличных тестах.
 */
export type PlanningPageResult = PlanningPageOwner & EntityPage<TaskRecord | WorkPlanRecord>;

/**
 * Материал наблюдённого графа: проверка переиспользования и смены логического состояния.
 */
export interface PlanningObservedGraph {
  /* Идентичность рассчитанного экземпляра, не глобальный кеш. */
  readonly instance: object;
  /* Готовность выбранной задачи в этом состоянии. */
  readonly progress: TaskProgress;
}
