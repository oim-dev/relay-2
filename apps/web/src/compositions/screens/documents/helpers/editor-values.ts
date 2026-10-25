import type { KnowledgeSnapshot } from "domains/knowledge";
import type { DocumentContent, DocumentSectionChange } from "domains/documents";
import type { DocumentValues } from "../types/document-editor.types";
import type { SectionValues } from "../ui/section-editor/types/section-editor-props.type";
import { messages } from "../config/documents.messages";

/**
 * Преобразует валидированный выбор формы в предметное действие каталога разделов.
 */
export function sectionChange(values: SectionValues): DocumentSectionChange {
  if (values.action === "create") {
    return { action: "create", name: values.name };
  }
  if (values.id === null) {
    throw new Error(messages.required);
  }
  switch (values.action) {
    case "update":
      return { action: "update", id: values.id, name: values.name };
    case "move":
      return { action: "move", id: values.id, before: values.before };
    case "remove":
      return { action: "remove", id: values.id };
  }
}

/**
 * Восстанавливает значения редактора из проверенной карточки документа.
 */
export function documentValues(
  source: KnowledgeSnapshot | null,
  sectionId: string | null,
): DocumentValues {
  const entity = source?.entity;
  if (entity?.kind !== "document") {
    return {
      name: "",
      summary: "",
      body: "",
      documentKind: "description",
      documentStatus: "draft",
      sectionId,
      pinned: false,
      relations: [],
    };
  }
  const data = entity.data;
  return {
    name: data.name,
    summary: data.summary,
    body: data.body,
    documentKind: data.documentKind,
    documentStatus: data.documentStatus,
    sectionId: data.sectionId,
    pinned: data.pinned,
    relations: data.relations.map((relation) => ({
      rowId: `${relation.target.id}:${relation.type}`,
      target: relation.target.id,
      targetKind: relation.target.kind,
      type: relation.type,
      description: relation.description,
    })),
  };
}

/**
 * Отделяет содержание документа от служебных ключей строк и незаполненных полей формы.
 */
export function documentContent(values: DocumentValues): DocumentContent {
  return {
    name: values.name,
    summary: values.summary,
    body: values.body,
    documentKind: values.documentKind,
    documentStatus: values.documentStatus,
    sectionId: values.sectionId,
    pinned: values.pinned,
    relations: values.relations.map((relation) => {
      if (relation.target === null) {
        throw new Error(messages.required);
      }
      return {
        target: { kind: relation.targetKind, id: relation.target },
        type: relation.type,
        description: relation.description,
      };
    }),
  };
}
