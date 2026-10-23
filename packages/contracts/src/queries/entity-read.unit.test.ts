import { describe, expect, test } from "bun:test";
import { validateEntityReadRequest } from "./entity-read";

const invalidSizes = [
  { name: "пустой набор", size: 0 },
  { name: "201 адрес", size: 201 },
] as const;
const validSizes = [1, 200] as const;
const invalidOptions = [
  { name: "неизвестное поле", options: { short: true } },
  { name: "строковый флаг summary", options: { summary: "true" } },
] as const;

describe("Форма группового чтения", () => {
  test.each(invalidSizes)("$name отклоняется как INVALID_ARGUMENT", ({ size }) => {
    const refs = Array.from({ length: size }, () => "DOC-1");

    expect(() => validateEntityReadRequest(refs)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2 }),
    );
  });

  test.each(validSizes)("%i адресов с повторами принимаются без изменения входа", (size) => {
    const refs = Object.freeze(Array.from({ length: size }, () => "document:DOC-1"));
    const options = Object.freeze({ summary: true });

    validateEntityReadRequest(refs, options);

    expect(refs).toEqual(Array.from({ length: size }, () => "document:DOC-1"));
    expect(options).toEqual({ summary: true });
  });

  test("синтаксическая ошибка отдельного адреса остаётся ответственностью resolver", () => {
    const refs = ["", "unknown:ID", "DOC-1"];

    expect(() => validateEntityReadRequest(refs)).not.toThrow();
  });

  test("нестроковый элемент внешнего вызова не превращается в строковый адрес", () => {
    expect(() => {
      // Намеренно нарушаем статический контракт, моделируя нетипизированную границу API.
      // @ts-expect-error Внешний вызывающий передал число вместо адреса.
      validateEntityReadRequest([1]);
    }).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2 }));
  });

  test.each(invalidOptions)("$name настроек отклоняется как INVALID_ARGUMENT", ({ options }) => {
    expect(() => {
      // @ts-expect-error Моделируем неверную форму настроек из нетипизированного внешнего вызова.
      validateEntityReadRequest(["DOC-1"], options);
    }).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2 }));
  });
});
