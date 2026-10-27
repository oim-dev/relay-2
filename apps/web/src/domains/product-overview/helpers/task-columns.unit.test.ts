import { describe, expect, test } from "bun:test";
import { taskColumns } from "./task-columns";
import { countRemainder } from "./count-remainder";

describe("Счётчики колонок обзора", () => {
  test("сохраняет явные нули и ненулевые значения Core", () => {
    const counts = { inbox: 3, ready: 0, "in-progress": 2, review: 1, done: 0, cancelled: 0 };

    expect(taskColumns(counts)).toEqual(counts);
  });

  test("отсутствующая колонка не превращается в нулевую", () => {
    expect(() => taskColumns({ inbox: 3 })).toThrow("счётчик колонки");
  });

  test("последняя категория сохраняет остаток total, а противоречие отклоняется", () => {
    expect(countRemainder(7, 2, 3)).toEqual({ total: 2 });
    expect(() => countRemainder(2, 1, 2)).toThrow("не согласованы");
  });
});
