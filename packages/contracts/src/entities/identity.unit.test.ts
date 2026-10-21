import { describe, expect, test } from "bun:test";
import { RelayError } from "../errors/relay-error";
import { isEntitySlug, isProjectName, validateActor } from "./identity";

const validActors = [
  { name: "одна кириллическая буква", actor: "Я" },
  { name: "внутренний пробел", actor: "agent name" },
  { name: "предельные 256 символов", actor: "a".repeat(256) },
] as const;

const invalidActors = [
  { name: "отсутствующее значение", actor: undefined },
  { name: "null", actor: null },
  { name: "число", actor: 42 },
  { name: "пустая строка", actor: "" },
  { name: "только пробел", actor: " " },
  { name: "пробел в начале", actor: " agent" },
  { name: "пробел в конце", actor: "agent " },
  { name: "табуляция", actor: "agent\tname" },
  { name: "нулевой символ", actor: "agent\0" },
  { name: "перенос строки", actor: "agent\n" },
  { name: "разделитель строк Unicode", actor: "agent\u2028name" },
  { name: "разделитель абзацев Unicode", actor: "agent\u2029name" },
  { name: "превышение 256 символов", actor: "a".repeat(257) },
] as const;

const nonStringValues = [
  { name: "отсутствующее значение", value: undefined },
  { name: "null", value: null },
  { name: "число", value: 12 },
  { name: "объект", value: { name: "relay" } },
] as const;

const validProjectNames = [
  { name: "один символ", value: "Я" },
  { name: "ровно 120 кодовых единиц UTF-16", value: "🚀".repeat(60) },
  { name: "Unicode и внутренние пробелы", value: "Проект\u00a0Relay 2" },
] as const;

const invalidProjectNames = [
  { name: "пустое имя", value: "" },
  { name: "121 кодовая единица UTF-16", value: "🚀".repeat(60) + "а" },
  { name: "начальный пробел", value: " Проект" },
  { name: "конечный неразрывный пробел", value: "Проект\u00a0" },
  { name: "NUL внутри имени", value: "Про\0ект" },
  { name: "управляющий символ C1", value: "Про\u0085ект" },
  { name: "разделитель строк U+2028", value: "Про\u2028ект" },
  { name: "разделитель абзацев U+2029", value: "Про\u2029ект" },
] as const;

const validSlugs = [
  { name: "минимальная длина два символа", value: "a1" },
  { name: "максимальная длина 64 символа", value: "a".repeat(64) },
  { name: "несколько частей с одиночными дефисами", value: "relay-2-api" },
] as const;

const invalidSlugs = [
  { name: "один символ", value: "a" },
  { name: "65 символов", value: "a".repeat(65) },
  { name: "заглавная буква", value: "Relay" },
  { name: "нелатинские буквы", value: "проект" },
  { name: "начальный дефис", value: "-relay" },
  { name: "конечный дефис", value: "relay-" },
  { name: "сдвоенный дефис", value: "relay--2" },
  { name: "подчёркивание", value: "relay_2" },
  { name: "краевой пробел", value: " relay" },
  { name: "завершающий перевод строки", value: "relay\n" },
] as const;

describe("Идентичность автора", () => {
  test.each(validActors)("$name сохраняется дословно", ({ actor }) => {
    const validated = validateActor(actor);

    expect(validated).toBe(actor);
  });

  test.each(invalidActors)("$name отклоняется как INVALID_ARGUMENT", ({ actor }) => {
    let caught: unknown;

    try {
      validateActor(actor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RelayError);
    expect(caught).toMatchObject({
      code: "INVALID_ARGUMENT",
      exitCode: 2,
      details: { field: "actor" },
    });
  });
});

describe("Нестроковые значения идентичности", () => {
  test.each(nonStringValues)("$name отклоняется без приведения или исключения", ({ value }) => {
    const projectName = isProjectName(value);
    const slug = isEntitySlug(value);

    expect(projectName).toBe(false);
    expect(slug).toBe(false);
  });
});

describe("Каноническое имя проекта", () => {
  test.each(validProjectNames)("$name допускается", ({ value }) => {
    const valid = isProjectName(value);

    expect(valid).toBe(true);
  });

  test.each(invalidProjectNames)("$name отклоняется без нормализации", ({ value }) => {
    const valid = isProjectName(value);

    expect(valid).toBe(false);
  });
});

describe("Slug проекта, приложения и доски", () => {
  test.each(validSlugs)("$name допускается", ({ value }) => {
    const valid = isEntitySlug(value);

    expect(valid).toBe(true);
  });

  test.each(invalidSlugs)("$name отклоняется без нормализации", ({ value }) => {
    const valid = isEntitySlug(value);

    expect(valid).toBe(false);
  });
});
