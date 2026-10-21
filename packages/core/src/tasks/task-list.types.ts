import type { TaskFilterInput } from "./task-input.types";

/**
 * Разрешённые ссылки и проверенные значения фильтров одного снимка.
 */
export interface TaskSelection extends Pick<
  TaskFilterInput,
  "column" | "completion" | "searchIn" | "query" | "readiness"
> {
  /* Постоянный ID доски; undefined не ограничивает доску. */
  readonly boardId: string | undefined;
  /* Постоянный ID родителя; null выбирает корни, undefined не ограничивает родителя. */
  readonly parentId: string | null | undefined;
  /* Постоянные ID подходящих целей; undefined не ограничивает цели. */
  readonly targetIds: ReadonlySet<string> | undefined;
}
