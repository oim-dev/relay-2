import type { NamedCommand } from "@relay/contracts";
import type { VersionedEntity } from "domains/project";
import { knowledgeGuard } from "domains/knowledge";
import type {
  DocumentContent,
  DocumentRelationChange,
  DocumentSectionChange,
  DocumentSnapshot,
} from "../types/document.types";
import { messages } from "../config/documents.messages";

/**
 * Уточняет готовое чтение, не перечитывая и не меняя исходные guards.
 */
export function isDocumentSnapshot(source: VersionedEntity): source is DocumentSnapshot {
  return source.entity.kind === "document";
}

/**
 * Создаёт точную команду содержания документа под исходной версией при изменении.
 */
export function documentCommand(
  source: VersionedEntity | null,
  content: DocumentContent,
): NamedCommand {
  if (source !== null && !isDocumentSnapshot(source)) {
    throw new Error(messages.wrongDocument);
  }
  return {
    op: source === null ? "document.create" : "document.update",
    ...(source === null ? {} : knowledgeGuard(source)),
    input: {
      name: content.name,
      summary: content.summary,
      body: content.body,
      documentKind: content.documentKind,
      documentStatus: content.documentStatus,
      sectionId: content.sectionId,
      pinned: content.pinned,
      relations: content.relations.map((relation) => ({
        target: relation.target,
        type: relation.type,
        description: relation.description,
      })),
    },
  };
}

/**
 * Адаптирует действие раздела к текущему каталогу Core под версией проекта.
 * Только поля выбранного действия передаются серверу, включая no-op.
 */
export function sectionCommand(
  source: VersionedEntity,
  change: DocumentSectionChange,
): NamedCommand {
  if (source.entity.kind !== "project") {
    throw new Error(messages.wrongProject);
  }
  let input: NonNullable<NamedCommand["input"]>;
  switch (change.action) {
    case "create":
      input = { name: change.name };
      break;
    case "update":
      input = { id: change.id, name: change.name };
      break;
    case "move":
      input = { id: change.id, before: change.before };
      break;
    case "remove":
      input = { id: change.id };
      break;
  }
  return { op: `document.section.${change.action}`, ...knowledgeGuard(source, true), input };
}

/**
 * Изменяет только отношение выбранного документа, сохраняя его первоначальные guards.
 * Для unlink описание запрещено Core и не попадает в input.
 */
export function documentRelationCommand(
  source: DocumentSnapshot,
  change: DocumentRelationChange,
): NamedCommand {
  const input = { target: change.target.id, type: change.type };
  return {
    op: `document.${change.action}`,
    ...knowledgeGuard(source),
    input: { ...input, ...(change.action === "link" ? { description: change.description } : {}) },
  };
}
