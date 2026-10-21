/**
 * Чистые правила состава разделов и проекция исторических ссылок документов.
 */
import { RelayError, type KnowledgeRecord } from "@relay/contracts";
import { KNOWLEDGE_LIMITS } from "./knowledge-constants";
import { knowledgeMessages } from "./knowledge.messages";
import { invalidKnowledge } from "./knowledge-validation";
import type {
  DocumentSectionChange,
  DocumentSectionIndex,
  DocumentSectionState,
} from "./document-sections.types";
export type { DocumentSectionIndex } from "./document-sections.types";

/**
 * Принимает уже декодированный проект из снимка текущей операции.
 */
export function indexDocumentSections(project: KnowledgeRecord<"project">): DocumentSectionIndex {
  return {
    active: new Set((project.data.documentSections ?? []).map((section) => section.id)),
    retired: new Set(project.data.retiredDocumentSectionIds ?? []),
  };
}

/**
 * Неизвестный ID — повреждение; историческая ссылка на удалённый раздел остаётся допустимой.
 */
export function validateDocumentSection(
  document: KnowledgeRecord<"document">,
  sections: DocumentSectionIndex,
): void {
  const id = document.data.sectionId;
  if (id !== null && !sections.active.has(id) && !sections.retired.has(id)) {
    throw new RelayError("CORRUPT_DATA", knowledgeMessages.unknownSection(document.key), 1, {
      id: document.id,
      field: "sectionId",
    });
  }
}

/**
 * Эффективный раздел библиотеки: удалённый раздел отображается как null без записи документа.
 */
export function projectDocumentSection(
  document: KnowledgeRecord<"document">,
  sections: DocumentSectionIndex,
): KnowledgeRecord<"document"> {
  validateDocumentSection(document, sections);
  const id = document.data.sectionId;
  return id === null || sections.active.has(id)
    ? document
    : { ...document, data: { ...document.data, sectionId: null } };
}

/**
 * Проверяет активность раздела нового или изменяемого документа; null оставляет его вне разделов.
 */
export function requireActiveDocumentSection(
  id: string | null,
  sections: DocumentSectionIndex,
): void {
  if (id !== null && !sections.active.has(id)) {
    throw new RelayError("NOT_FOUND", knowledgeMessages.sectionNotFound(id), 3);
  }
}

/**
 * Рассчитывает новый порядок и резерв ID, не изменяя переданный проект.
 * Исторический ID нельзя использовать повторно; снятие не меняет документы.
 * Ревизия и сохранение результата принадлежат внешней транзакции проекта.
 */
export function changeDocumentSections(
  project: KnowledgeRecord<"project">,
  change: DocumentSectionChange,
): DocumentSectionState {
  const sections = [...(project.data.documentSections ?? [])];
  const retired = [...(project.data.retiredDocumentSectionIds ?? [])];
  const index = sections.findIndex((section) => section.id === change.id);
  if (change.action === "create") {
    if (index !== -1 || retired.includes(change.id)) {
      throw new RelayError("ALREADY_EXISTS", knowledgeMessages.sectionExists(change.id), 4);
    }
    if (sections.length >= KNOWLEDGE_LIMITS.sections) {
      invalidKnowledge(knowledgeMessages.sectionLimit);
    }
    sections.push({ id: change.id, name: change.name });
  } else {
    const section = sections[index];
    if (section === undefined) {
      throw new RelayError("NOT_FOUND", knowledgeMessages.sectionNotFound(change.id), 3);
    }
    switch (change.action) {
      case "update":
        sections[index] = { ...section, name: change.name };
        break;
      case "remove":
        sections.splice(index, 1);
        retired.push(change.id);
        break;
      case "move": {
        if (change.before === change.id) {
          invalidKnowledge(knowledgeMessages.sectionSelfMove);
        }
        if (change.before !== null && !sections.some((item) => item.id === change.before)) {
          throw new RelayError("NOT_FOUND", knowledgeMessages.sectionNotFound(change.before), 3);
        }
        sections.splice(index, 1);
        const beforeIndex =
          change.before === null
            ? sections.length
            : sections.findIndex((item) => item.id === change.before);
        sections.splice(beforeIndex, 0, section);
        break;
      }
    }
  }
  return { documentSections: sections, retiredDocumentSectionIds: retired };
}
