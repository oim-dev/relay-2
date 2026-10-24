import { describe, expect, test } from "bun:test";
import { RelayError, type EntityRecord } from "@relay/contracts";
import { assertKnowledgeTransition } from "./knowledge-transition";

const immutableCases = [
  { kind: "scenario", field: "featureId" },
  { kind: "application", field: "slug" },
  { kind: "application", field: "prefix" },
  { kind: "application", field: "boardId" },
  { kind: "implementation", field: "applicationId" },
  { kind: "implementation", field: "featureId" },
  { kind: "implementation", field: "scenarioId" },
  { kind: "implementation", field: "targetId" },
  { kind: "implementation", field: "targetKind" },
  { kind: "board", field: "slug" },
  { kind: "board", field: "prefix" },
  { kind: "board", field: "applicationId" },
] as const;
const repeatedProductCreation = [
  { name: "новое содержание заполненного паспорта", changed: true },
  { name: "неизменный заполненный паспорт без эффектов", changed: false },
] as const;

/**
 * Полная карточка без SQLite; проверка перехода не получает resolver или генератор метаданных.
 */
function storedKnowledge(kind: (typeof immutableCases)[number]["kind"] | "product"): EntityRecord {
  const data = {
    product: {
      name: "Заполненный паспорт",
      summary: "Описание продукта",
      description: "Исходный текст",
    },
    scenario: { name: "Сценарий", summary: "", description: "", featureId: "feature-id" },
    application: {
      name: "Web",
      summary: "",
      description: "",
      slug: "web",
      prefix: "WEB",
      type: "frontend",
      boardId: "board-id",
      implementationIds: [],
    },
    implementation: {
      title: "Реализация",
      description: "",
      status: "none",
      active: true,
      applicationId: "application-id",
      featureId: "feature-id",
      scenarioId: "scenario-id",
      targetId: "scenario-id",
      targetKind: "scenario",
    },
    board: {
      name: "Web",
      slug: "web",
      prefix: "WEB",
      description: "",
      applicationId: "application-id",
    },
  };
  return {
    id: `${kind}-id`,
    kind,
    key: `${kind}-key`,
    revision: 2,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    createdBy: "author",
    updatedBy: "author",
    data: structuredClone(data[kind]),
  };
}

describe("Неизменяемые связи готового knowledge-перехода", () => {
  test.each(immutableCases)("replication не перепривязывает $kind.$field", ({ kind, field }) => {
    const previous = storedKnowledge(kind);
    const next = {
      ...previous,
      revision: previous.revision + 1,
      data: { ...previous.data, [field]: "foreign" },
    };

    let caught: unknown;
    try {
      assertKnowledgeTransition(previous, next);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RelayError);
    expect(caught).toMatchObject({ code: "INVALID_STATE", details: { id: previous.id, field } });
    expect(previous.data[field]).not.toBe("foreign");
  });

  test("application.create разрешает только первое заполнение boardId rev1→rev2", () => {
    const next = storedKnowledge("application");
    const { boardId: _boardId, ...initialData } = next.data;
    const initial = { ...next, revision: 1, data: initialData };

    expect(() =>
      assertKnowledgeTransition(initial, next, { operation: "application.create" }),
    ).not.toThrow();
    expect(() => assertKnowledgeTransition(initial, next, { operation: "replication" })).toThrow(
      RelayError,
    );
    expect(() =>
      assertKnowledgeTransition(
        next,
        { ...next, revision: 3, data: { ...next.data, boardId: "foreign" } },
        { operation: "application.create" },
      ),
    ).toThrow(RelayError);
  });

  test("legacy допускает изменяемое содержание, а rename не маскирует его правку", () => {
    const previous = storedKnowledge("scenario");
    const next = {
      ...previous,
      revision: previous.revision + 1,
      data: { ...previous.data, description: "Уточнение" },
    };

    expect(() =>
      assertKnowledgeTransition(previous, next, { operation: "replication" }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeTransition(previous, next, { operation: "scenario.update" }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeTransition(previous, next, { operation: "scenario.rename" }),
    ).toThrow(RelayError);
  });
});

describe("Одноразовое заполнение паспорта в общем transition validator", () => {
  test.each(repeatedProductCreation)("product.create: $name отклоняется", ({ changed }) => {
    const previous = storedKnowledge("product");
    const next = changed
      ? {
          ...previous,
          revision: previous.revision + 1,
          data: {
            ...previous.data,
            name: "Недопустимый второй create",
            description: "Другой текст",
          },
        }
      : structuredClone(previous);

    let caught: unknown;
    try {
      assertKnowledgeTransition(previous, next, { operation: "product.create" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RelayError);
    expect(caught).toMatchObject({ code: "ALREADY_EXISTS", exitCode: 4 });
    expect(previous.data).toEqual({
      name: "Заполненный паспорт",
      summary: "Описание продукта",
      description: "Исходный текст",
    });
  });

  test("product.create заполняет пустой seed, а product.update сохраняет право обычной правки", () => {
    const filled = storedKnowledge("product");
    const empty = { ...filled, revision: 1, data: {} };
    const edited = {
      ...filled,
      revision: filled.revision + 1,
      data: { ...filled.data, description: "Новая редакция" },
    };

    expect(() =>
      assertKnowledgeTransition(empty, filled, { operation: "product.create" }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeTransition(filled, edited, { operation: "product.update" }),
    ).not.toThrow();
    expect(empty.data).toEqual({});
  });
});
