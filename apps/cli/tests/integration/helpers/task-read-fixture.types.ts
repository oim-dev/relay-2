import type { TaskComment, TaskCriterion, TaskRecord } from "@relay/contracts";

/**
 * Задача и ожидаемый полный состав для проверки вложенной страницы CLI.
 */
export interface TaskReadFixture {
  /* Состояние владельца после подготовки, включая независимый журнал. */
  readonly task: TaskRecord;
  /* Ожидаемые записи в сохранённом порядке, до применения окна CLI. */
  readonly items: readonly (TaskRecord | TaskCriterion | TaskComment)[];
}
