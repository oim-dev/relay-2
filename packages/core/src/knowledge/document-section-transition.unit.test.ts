import { describe, expect, test } from "bun:test";
import type { KnowledgeRecord } from "@relay/contracts";
import { assertKnowledgeTransition } from "./knowledge-transition";

const sections = [
  { id: "A", name: "A" },
  { id: "B", name: "B" },
  { id: "C", name: "C" },
];
const changes = [
  {
    name: "update A переименовывает B",
    operation: "document.section.update",
    sectionId: "A",
    sections: sections.map((section) =>
      section.id === "B" ? { ...section, name: "Подмена" } : section,
    ),
    retired: ["old"],
  },
  {
    name: "move A переставляет B/C",
    operation: "document.section.move",
    sectionId: "A",
    sections: [sections[0], sections[2], sections[1]],
    retired: ["old"],
  },
  {
    name: "remove A снимает B",
    operation: "document.section.remove",
    sectionId: "A",
    sections: sections.filter((section) => section.id !== "B"),
    retired: ["old", "B"],
  },
  {
    name: "update A меняет вечный резерв",
    operation: "document.section.update",
    sectionId: "A",
    sections,
    retired: [],
  },
  {
    name: "create переиспользует снятый ID",
    operation: "document.section.create",
    sectionId: "old",
    sections: [...sections, { id: "old", name: "Снова" }],
    retired: [],
  },
];

/**
 * Минимальный проект с тремя действующими разделами и одним неизменяемым резервом.
 */
function project(): KnowledgeRecord<"project"> {
  return {
    id: "project",
    key: "PROJECT",
    kind: "project",
    revision: 4,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    createdBy: "author",
    updatedBy: "author",
    data: {
      name: "Проект",
      slug: "project",
      documentSections: structuredClone(sections),
      retiredDocumentSectionIds: ["old"],
    },
  };
}

describe("Область pure перехода раздела документов", () => {
  test.each(changes)("$name запрещено", ({ operation, sectionId, sections, retired }) => {
    const before = project();
    const next = {
      ...before,
      data: { ...before.data, documentSections: sections, retiredDocumentSectionIds: retired },
    };

    expect(() => assertKnowledgeTransition(before, next, { operation, sectionId })).toThrow(
      expect.objectContaining({ code: "INVALID_STATE" }),
    );
  });

  test("снятие только A сохраняет соседей и добавляет резерв, перемещение только A сохраняет имена", () => {
    const before = project();
    const removed = {
      ...before,
      data: {
        ...before.data,
        documentSections: sections.slice(1),
        retiredDocumentSectionIds: ["old", "A"],
      },
    };
    const moved = {
      ...before,
      data: { ...before.data, documentSections: [...sections.slice(1), ...sections.slice(0, 1)] },
    };

    expect(() =>
      assertKnowledgeTransition(before, removed, {
        operation: "document.section.remove",
        sectionId: "A",
      }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeTransition(before, moved, {
        operation: "document.section.move",
        sectionId: "A",
        beforeSectionId: null,
      }),
    ).not.toThrow();
  });

  test("no-op update проверяет выбранный раздел и требует явную цель", () => {
    const before = project();

    expect(() =>
      assertKnowledgeTransition(before, before, {
        operation: "document.section.update",
        sectionId: "A",
      }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeTransition(before, before, {
        operation: "document.section.update",
        sectionId: "missing",
      }),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() =>
      assertKnowledgeTransition(before, before, { operation: "document.section.update" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
  });
});
