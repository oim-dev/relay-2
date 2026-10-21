import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initializeProject } from "@relay/project-runtime";
import { RuntimeFixture, runtimeErrorCode, withProjectDatabase } from "./helpers/runtime-fixture";

const validSlugs = [
  { name: "минимальная длина", slug: "ab" },
  { name: "несколько частей с цифрами", slug: "web-api-2" },
  { name: "максимальная длина", slug: "a".repeat(64) },
] as const;

const invalidSlugs = [
  { name: "пустой", slug: "" },
  { name: "короче минимума", slug: "a" },
  { name: "длиннее максимума", slug: "a".repeat(65) },
  { name: "кириллица", slug: "Проект" },
  { name: "заглавные буквы", slug: "Upper" },
  { name: "пробел внутри", slug: "with space" },
  { name: "подчёркивание", slug: "a_b" },
  { name: "начальный дефис", slug: "-start" },
  { name: "конечный дефис", slug: "end-" },
  { name: "двойной дефис", slug: "double--dash" },
  { name: "переход к родительскому пути", slug: "../path" },
  { name: "пробел в конце", slug: "slug " },
  { name: "перевод строки в конце", slug: "slug\n" },
] as const;

const fallbackNames = [
  { name: "кириллическое имя", input: "Русское имя" },
  { name: "один кириллический символ", input: "Я" },
  { name: "только дефисы", input: "---" },
  { name: "слишком длинный производный slug", input: "a".repeat(65) },
] as const;

const invalidNames = [
  { name: "только пробел", input: " " },
  { name: "длиннее максимума", input: "a".repeat(121) },
  { name: "перевод строки", input: "Первая\nВторая" },
  { name: "разделитель строк Unicode", input: "Первая\u2028Вторая" },
  { name: "управляющий символ", input: "Мой\tпроект" },
] as const;

describe("Имя и slug при инициализации проекта", () => {
  let fixture: RuntimeFixture;

  beforeEach(() => {
    fixture = new RuntimeFixture();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  test.each(validSlugs)("сохраняет явный slug: $name", ({ slug }) => {
    const { cwd, home } = fixture;

    const project = initializeProject({ cwd, home, name: "  Мой проект  ", slug });

    withProjectDatabase(project, (database) => {
      expect(database.get("PROJECT")?.data).toEqual({ name: "Мой проект", slug });
    });
  });

  test.each(invalidSlugs)("отклоняет явный slug до создания файлов: $name", ({ slug }) => {
    const { cwd, home } = fixture;
    const nested = join(cwd, "not-created", "project");

    const code = runtimeErrorCode(() => initializeProject({ cwd: nested, home, slug }));

    expect(code).toBe("INVALID_ARGUMENT");
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  test.each(fallbackNames)("генерирует адрес от ID: $name", ({ input }) => {
    const { cwd, home } = fixture;

    const project = initializeProject({ cwd, home, name: input });

    withProjectDatabase(project, (database) => {
      expect(database.get("PROJECT")?.data).toEqual({
        name: input,
        slug: `project-${project.projectId.slice(0, 8)}`,
      });
    });
  });

  test("выводит латинский адрес с дефисами из подходящего имени", () => {
    const { cwd, home } = fixture;

    const project = initializeProject({ cwd, home, name: "  Relay CLI 2  " });

    withProjectDatabase(project, (database) => {
      expect(database.get("PROJECT")?.data).toEqual({ name: "Relay CLI 2", slug: "relay-cli-2" });
    });
  });

  test.each(invalidNames)("отклоняет имя до создания файлов: $name", ({ input }) => {
    const { cwd, home } = fixture;

    const code = runtimeErrorCode(() => initializeProject({ cwd, home, name: input }));

    expect(code).toBe("INVALID_ARGUMENT");
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });
});
