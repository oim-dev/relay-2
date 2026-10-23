import type { TaskCriterion } from "@relay/contracts";

/**
 * Метаданные владельца вложенного чтения из того же снимка, что и возвращённые данные.
 */
export interface TaskReadOwner {
  /* Текущий читаемый ключ задачи, даже если запрос использовал её прежний алиас. */
  readonly task: string;
  /* Ревизия содержания задачи; публикация комментариев её не изменяет. */
  readonly revision: number;
}

/**
 * Полный состав задачи с метаданными владельца; окно выдачи выбирает потребитель.
 */
export interface TaskCollection<T> extends TaskReadOwner {
  /* Все элементы в сохранённом порядке; пустой массив означает отсутствие состава. */
  readonly items: T[];
}

/**
 * Критерий приёмки вместе с ключом и ревизией содержания его задачи.
 */
export interface TaskCriterionRead extends TaskReadOwner {
  /* Проверенный критерий, найденный по постоянному ID только внутри указанной задачи. */
  readonly criterion: TaskCriterion;
}
