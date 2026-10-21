/** Проверка принадлежности документа разделу и проекция легально удалённого раздела. */
import { RelayError, type KnowledgeRecord } from "@relay/contracts";

export interface DocumentSectionIndex {
  active: ReadonlySet<string>;
  retired: ReadonlySet<string>;
}

/** Принимает уже декодированный проект из снимка текущей операции. */
export function indexDocumentSections(project: KnowledgeRecord<"project">): DocumentSectionIndex {
  return {
    active: new Set((project.data.documentSections ?? []).map((section) => section.id)),
    retired: new Set(project.data.retiredDocumentSectionIds ?? []),
  };
}

/** Неизвестный ID — повреждение; историческая ссылка на удалённый раздел остаётся допустимой. */
export function validateDocumentSection(
  document: KnowledgeRecord<"document">,
  sections: DocumentSectionIndex,
): void {
  const id = document.data.sectionId;
  if (id !== null && !sections.active.has(id) && !sections.retired.has(id)) {
    throw new RelayError(
      "CORRUPT_DATA",
      `Раздел документа ${document.key} не зарегистрирован в проекте.`,
      1,
      { id: document.id, field: "sectionId" },
    );
  }
}

/** Эффективный раздел библиотеки: удалённый раздел отображается как null без записи документа. */
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
