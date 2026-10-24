import { KNOWLEDGE_LIMITS } from "./knowledge-constants";
import { knowledgeMessages } from "./knowledge.messages";
import type { DocumentSectionAction, DocumentSectionChange } from "./document-sections.types";
import {
  invalidKnowledge,
  knowledgeBoolean,
  knowledgeFields,
  knowledgeName,
  knowledgeText,
} from "./knowledge-validation";

/**
 * Разбирает форму операции над разделом без чтения проекта и изменения порядка.
 * Вызывающий предварительно проверяет action и CAS проекта и выделяет ID создания.
 */
export function parseDocumentSectionChange(
  action: DocumentSectionAction,
  value: unknown,
  allocatedId?: string,
): DocumentSectionChange {
  const allowed = {
    create: ["id", "name"],
    update: ["id", "name"],
    move: ["id", "before", "last"],
    remove: ["id"],
  } as const;
  const input = knowledgeFields(value, allowed[action]);
  const id =
    action === "create" && !Object.hasOwn(input, "id")
      ? knowledgeText(allocatedId, "id", true)
      : knowledgeText(input.id, "id", true);
  if (id.length > KNOWLEDGE_LIMITS.sectionId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)) {
    invalidKnowledge(knowledgeMessages.sectionId);
  }
  if (action === "create" || action === "update") {
    return { action, id, name: knowledgeName(input.name) };
  }
  if (action === "remove") {
    return { action, id };
  }
  if (Object.hasOwn(input, "last")) {
    knowledgeBoolean(input.last, "last");
  }
  if (Object.hasOwn(input, "before") === (input.last === true)) {
    invalidKnowledge(knowledgeMessages.sectionPosition);
  }
  const before =
    input.last === true || input.before === null
      ? null
      : knowledgeText(input.before, "before", true);
  return { action, id, before };
}
