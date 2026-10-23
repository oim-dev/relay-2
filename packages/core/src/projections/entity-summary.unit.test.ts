import { describe, expect, test } from "bun:test";
import type { EntitySummaryProjection } from "@relay/storage";
import { decodeEntitySummary } from "./entity-summary";

const invalidFields = [
  {
    name: "пустой заголовок",
    kind: "document",
    title: " ",
    state: "draft",
    active: undefined,
    field: "title",
  },
  {
    name: "многострочное название",
    kind: "feature",
    title: "Первая\nВторая",
    state: undefined,
    active: undefined,
    field: "title",
  },
  {
    name: "null имени продукта",
    kind: "product",
    title: null,
    state: undefined,
    active: undefined,
    field: "title",
  },
  {
    name: "неизвестная колонка",
    kind: "task",
    title: "Задача",
    state: "unknown",
    active: undefined,
    field: "column",
  },
  {
    name: "отсутствующий статус документа",
    kind: "document",
    title: "Правила",
    state: undefined,
    active: undefined,
    field: "documentStatus",
  },
  {
    name: "число вместо активности",
    kind: "implementation",
    title: "Реализация",
    state: "none",
    active: 0,
    field: "active",
  },
] as const;

const acceptedTitles = [
  { name: "каноническое имя проекта предельной длины", kind: "project", title: "Я".repeat(120) },
  { name: "имя продукта с краевыми пробелами", kind: "product", title: " Продукт " },
  { name: "фича без лимита длины планирования", kind: "feature", title: "Ф".repeat(161) },
  { name: "сценарий с NUL", kind: "scenario", title: "До\0после" },
  { name: "приложение с табуляцией", kind: "application", title: "До\tпосле" },
  { name: "доска с краевыми пробелами", kind: "board", title: " Доска " },
  {
    name: "документ без лимита длины планирования",
    kind: "document",
    title: "Д".repeat(161),
    state: "draft",
  },
  {
    name: "реализация с NUL",
    kind: "implementation",
    title: "До\0после",
    state: "none",
    active: true,
  },
  { name: "задача предельной длины", kind: "task", title: "З".repeat(1024), state: "inbox" },
  { name: "план предельной длины", kind: "work-plan", title: "П".repeat(160), state: "draft" },
  { name: "релиз предельной длины", kind: "release", title: "Р".repeat(160), state: "planned" },
  {
    name: "сессия с U+2028 и U+2029",
    kind: "work-session",
    title: "До\u2028и\u2029после",
    state: "open",
  },
  {
    name: "материал истории с NUL без лимита длины",
    kind: "work-checkpoint",
    title: "До\0" + "М".repeat(1025),
  },
] as const;
const corruptedTitles = [
  { name: "краевые пробелы проекта", kind: "project", title: " Имя " },
  { name: "превышение длины имени проекта", kind: "project", title: "П".repeat(121) },
  { name: "управляющий символ имени проекта", kind: "project", title: "До\tпосле" },
  { name: "U+2028 в знании", kind: "feature", title: "До\u2028после" },
  {
    name: "U+2029 в знании",
    kind: "implementation",
    title: "До\u2029после",
    state: "none",
    active: true,
  },
  { name: "161 символ плана", kind: "work-plan", title: "П".repeat(161), state: "draft" },
  { name: "NUL плана", kind: "work-plan", title: "До\0после", state: "draft" },
  { name: "161 символ релиза", kind: "release", title: "Р".repeat(161), state: "planned" },
  { name: "NUL релиза", kind: "release", title: "До\0после", state: "planned" },
  { name: "CR сессии", kind: "work-session", title: "До\rпосле", state: "open" },
  { name: "LF материала истории", kind: "work-checkpoint", title: "До\nпосле" },
] as const;

describe("Декодирование узкой карточки", () => {
  test.each(acceptedTitles)("$name сохраняется по правилу предметного владельца", (sample) => {
    const record: EntitySummaryProjection = {
      id: "record-id",
      key: "KEY",
      revision: 1,
      state: undefined,
      active: undefined,
      ...sample,
    };

    const result = decodeEntitySummary(record);

    expect(result.title).toBe(sample.title);
  });

  test.each(corruptedTitles)("$name даёт CORRUPT_DATA выбранного поля", (sample) => {
    const record: EntitySummaryProjection = {
      id: "record-id",
      key: "KEY",
      revision: 1,
      state: undefined,
      active: undefined,
      ...sample,
    };

    expect(() => decodeEntitySummary(record)).toThrow(
      expect.objectContaining({
        code: "CORRUPT_DATA",
        exitCode: 1,
        details: { id: record.id, kind: sample.kind, field: "title" },
      }),
    );
  });

  test.each(invalidFields)("$name отклоняется без исправления проекции", ({ field, ...fields }) => {
    const record: EntitySummaryProjection = Object.freeze({
      id: "record-id",
      key: "KEY",
      revision: 1,
      ...fields,
    });

    expect(() => decodeEntitySummary(record)).toThrow(
      expect.objectContaining({
        code: "CORRUPT_DATA",
        exitCode: 1,
        details: { id: "record-id", kind: fields.kind, field },
      }),
    );
  });

  test("отсутствующее имя seed-продукта отображается текущим ключом без выдуманного статуса", () => {
    const record: EntitySummaryProjection = {
      id: "product-id",
      kind: "product",
      key: "RENAMED-PRODUCT",
      revision: 2,
      title: undefined,
      state: undefined,
      active: undefined,
    };

    const result = decodeEntitySummary(record);

    expect(result).toEqual({
      id: "product-id",
      kind: "product",
      key: "RENAMED-PRODUCT",
      revision: 2,
      title: "RENAMED-PRODUCT",
    });
  });
});
