import { isDeepStrictEqual } from "node:util";
import { RelayError, type KnowledgeRecord } from "@relay/contracts";
import { indexDocumentSections, requireActiveDocumentSection } from "./document-sections";
import type { KnowledgeTransitionContext } from "./knowledge-command.types";
import { knowledgeMessages } from "./knowledge.messages";

/**
 * Отклоняет нарушение области выбранного раздела, не выдавая чужую правку за no-op цели.
 */
function invalidSectionTransition(projectId: string): never {
  throw new RelayError("INVALID_STATE", knowledgeMessages.immutableTransition, 4, {
    id: projectId,
    field: "documentSections",
  });
}

/**
 * Проверяет существование и ожидаемое присутствие выбранной цели, включая no-op и вечный резерв ID.
 */
function assertSelectedSection(
  previous: Readonly<KnowledgeRecord<"project">>,
  next: Readonly<KnowledgeRecord<"project">>,
  context: KnowledgeTransitionContext,
): string {
  const id = context.sectionId;
  if (id === undefined) {
    invalidSectionTransition(previous.id);
  }
  const before = previous.data.documentSections ?? [];
  const after = next.data.documentSections ?? [];
  const oldRetired = previous.data.retiredDocumentSectionIds ?? [];
  const newRetired = next.data.retiredDocumentSectionIds ?? [];
  const oldSection = before.find((section) => section.id === id);
  const newSection = after.find((section) => section.id === id);
  if (context.operation === "document.section.create") {
    if (oldSection !== undefined || oldRetired.includes(id) || newSection === undefined) {
      invalidSectionTransition(previous.id);
    }
  } else {
    requireActiveDocumentSection(id, indexDocumentSections(previous));
    if (context.operation === "document.section.remove") {
      if (newSection !== undefined || !newRetired.includes(id)) {
        invalidSectionTransition(previous.id);
      }
    } else if (newSection === undefined) {
      invalidSectionTransition(previous.id);
    }
  }
  return id;
}

/**
 * Проверяет готовую границу одной команды раздела относительно текущего canonical before.
 * Соседние разделы и их взаимный порядок неизменны; update не меняет порядок цели, move — её имя.
 * Remove снимает только цель и добавляет её вечный резерв; документы сохраняют исторические ссылки.
 * Create не переиспользует резерв. Новый элемент/резерв может соседствовать с конкурентной вставкой.
 * Работает и для no-op, не вызывает calculator и не обращается к хранилищу.
 */
export function assertDocumentSectionTransition(
  previous: Readonly<KnowledgeRecord<"project">>,
  next: Readonly<KnowledgeRecord<"project">>,
  context: KnowledgeTransitionContext,
): void {
  const id = assertSelectedSection(previous, next, context);
  const before = previous.data.documentSections ?? [];
  const after = next.data.documentSections ?? [];
  const oldRetired = previous.data.retiredDocumentSectionIds ?? [];
  const newRetired = next.data.retiredDocumentSectionIds ?? [];
  if (
    !isDeepStrictEqual(
      before.filter((section) => section.id !== id),
      after.filter((section) => section.id !== id),
    ) ||
    !isDeepStrictEqual(
      oldRetired,
      context.operation === "document.section.remove"
        ? newRetired.filter((retired) => retired !== id)
        : newRetired,
    )
  ) {
    invalidSectionTransition(previous.id);
  }
  if (context.operation === "document.section.update") {
    if (
      !isDeepStrictEqual(
        before.map((section) => section.id),
        after.map((section) => section.id),
      )
    ) {
      invalidSectionTransition(previous.id);
    }
  } else if (context.operation === "document.section.move") {
    const oldSection = before.find((section) => section.id === id);
    const newSection = after.find((section) => section.id === id);
    if (!isDeepStrictEqual(oldSection, newSection) || context.beforeSectionId === id) {
      invalidSectionTransition(previous.id);
    }
    if (context.beforeSectionId !== undefined) {
      requireActiveDocumentSection(context.beforeSectionId, indexDocumentSections(previous));
    }
  } else if (
    context.operation !== "document.section.create" &&
    context.operation !== "document.section.remove"
  ) {
    invalidSectionTransition(previous.id);
  }
}
