import type { EntityPageRequest, TaskViewAssignment } from "@relay/contracts";
import type { TaskFilterInput } from "./task-input.types";

/**
 * Проверенный ввод компактной страницы и подбора задач.
 */
export interface TaskViewInput {
  /* Текущие фильтры TasksService, без правил старого Web. */
  readonly filters: TaskFilterInput;
  /* Ограниченное окно и стабильная сортировка. */
  readonly page: EntityPageRequest;
  /* Поколение продолжения; undefined только при первом чтении. */
  readonly generation: number | undefined;
  /* Адрес единственной задачи либо undefined для каталога. */
  readonly ref: string | undefined;
  /* Адресный набор; undefined выбирает обычный каталог. */
  readonly refs: readonly string[] | undefined;
  /* Адрес плана редактируемого состава либо undefined. */
  readonly plan: string | undefined;
  /* Постоянный ID этапа редактируемого состава либо undefined. */
  readonly stageId: string | undefined;
  /* Фильтровать ли чужие открытые включения до окна. */
  readonly availableOnly: boolean;
}

/**
 * Индекс включений и разрешённый адрес редактируемого состава одного снимка.
 */
export interface TaskCandidateSelection {
  /* Единственное открытое включение каждой задачи. */
  readonly assignments: ReadonlyMap<string, TaskViewAssignment>;
  /* Постоянный ID текущего плана; undefined без редактируемого состава. */
  readonly planId: string | undefined;
  /* Постоянный ID этапа текущего плана либо undefined. */
  readonly stageId: string | undefined;
}
