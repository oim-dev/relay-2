import type { EntityRecord, TaskCriterion, TaskRecord } from "@relay/contracts";

/**
 * Минимальная задача с одним невыполненным критерием для подготовки CLI-переходов.
 */
export interface TaskWithCriterion {
  /* Сохранённая задача; её ревизия защищает изменение критерия. */
  readonly task: TaskRecord;

  /* Единственный критерий этой задачи с постоянным ID. */
  readonly criterion: TaskCriterion;
}

/**
 * Намеренно повреждённая запись и поколение сразу после внедрения повреждения.
 */
export interface CorruptedTaskFixture {
  /* Задача с недопустимым null в dependencies; декодирование Core должно отказать. */
  readonly damaged: EntityRecord;

  /* Поколение проекта, которое проверяемая команда обязана сохранить. */
  readonly generation: number;
}
