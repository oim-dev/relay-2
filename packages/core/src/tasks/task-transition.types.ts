import type { KnowledgeRecord } from "@relay/contracts";
import type { TaskTarget } from "./task-data.types";
import type { TaskGraph } from "./task-graph";

/**
 * Уже рассчитанные основания проверки одного перехода, пригодные и для проверки публикации.
 * Граф содержит next на границе данного шага, а не финальный граф всего пакета.
 */
export interface TaskTransitionContext {
  /* Имя команды уточняет проверки no-op; без имени проверяются фактические изменения. */
  readonly operation?: string;
  /* Явная основная цель task.criterion.*; нужна также для проверки no-op и удаления. */
  readonly criterionId?: string;
  /* Зафиксированный автор исходного перехода; отсутствие не подменяется автором карточки. */
  readonly actor?: string;
  /* Выделенное время исходного перехода; отсутствие не доказывает часы legacy-команды. */
  readonly timestamp?: string;
  /* Общий граф кандидата; обязателен для создания, переноса и изменений обязательств/связей. */
  readonly graph?: TaskGraph;
  /* Разрешённая доска next; нужна при создании, переносе или проверке назначения целей. */
  readonly board?: KnowledgeRecord<"board">;
  /* Цели next в сохранённом порядке, уже декодированные владельцем знаний. */
  readonly targets?: readonly TaskTarget[];
}
