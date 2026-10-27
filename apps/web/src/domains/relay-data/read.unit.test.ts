/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { pageGeneration } from "./read";

describe("Поколение продолжения списка", () => {
  test.each([
    { name: "начальная страница", input: undefined, expected: undefined },
    { name: "нулевое поколение", input: "0", expected: 0 },
    { name: "обычное поколение", input: "42", expected: 42 },
  ])("$name сохраняет поколение без подстановки текущего", ({ input, expected }) => {
    const generation = pageGeneration(input);

    expect(generation).toBe(expected);
  });

  test.each([
    { name: "пустая строка", input: "" },
    { name: "пробельная строка", input: " " },
    { name: "отрицательное поколение", input: "-1" },
    { name: "дробное поколение", input: "1.5" },
    { name: "потеря точности", input: "9007199254740992" },
  ])("$name отклоняется, а не превращается в другую страницу", ({ input }) => {
    expect(() => pageGeneration(input)).toThrow("Некорректная версия продолжения списка");
  });
});
