import type { TaskColumn } from "@relay/contracts";

/**
 * Проверяет обязательные счётчики Core. Отсутствующая колонка не означает ноль.
 */
export function taskColumns(input: Readonly<Record<string, number>>): Record<TaskColumn, number> {
  /**
   * Принимает только точный неотрицательный счётчик.
   */
  const count = (column: TaskColumn): number => {
    const value = input[column];
    if (value === undefined || !Number.isSafeInteger(value) || value < 0)
      throw new Error("В обзоре отсутствует корректный счётчик колонки задач.");
    return value;
  };
  return {
    inbox: count("inbox"),
    ready: count("ready"),
    "in-progress": count("in-progress"),
    review: count("review"),
    done: count("done"),
    cancelled: count("cancelled"),
  };
}
