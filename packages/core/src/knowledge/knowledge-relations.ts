/**
 * Чистые правила отношений документов и совместимый адаптер синхронного resolver.
 */
import {
  DOCUMENT_TARGET_KINDS,
  type DocumentRelation,
  type KnowledgeRecord,
} from "@relay/contracts";
import { KNOWLEDGE_LIMITS } from "./knowledge-constants";
import { knowledgeMessages } from "./knowledge.messages";
import type {
  KnowledgeLinkChange,
  KnowledgeReference,
  KnowledgeRelationInput,
  KnowledgeResolver,
  PreparedKnowledgeRelation,
} from "./knowledge.types";
import { invalidKnowledge } from "./knowledge-validation";

/**
 * Проверяет допустимость цели и возвращает постоянную типизированную ссылку.
 * Снятая реализация допустима для снятия пары либо изменения уже существующего отношения.
 */
export function relationTarget(
  target: KnowledgeReference,
  documentId: string | undefined,
  existing: boolean,
): DocumentRelation["target"] {
  const kind = DOCUMENT_TARGET_KINDS.find((variant) => variant === target.kind);
  if (kind === undefined) {
    invalidKnowledge(knowledgeMessages.relationTarget);
  }
  if (target.id === documentId) {
    invalidKnowledge(knowledgeMessages.relationSelf);
  }
  if (!existing && target.kind === "implementation" && target.data.active !== true) {
    invalidKnowledge(knowledgeMessages.inactiveRelation);
  }
  return { kind, id: target.id };
}

/**
 * Разрешает новый полный состав отношений под снимком записи и сохраняет порядок ввода.
 * Дубликаты проверяются после разрешения алиасов; прежние снятые реализации остаются допустимы.
 */
export function resolveKnowledgeRelations(
  input: readonly KnowledgeRelationInput[],
  reader: KnowledgeResolver,
  current?: KnowledgeRecord<"document">,
): DocumentRelation[] {
  return resolvePreparedKnowledgeRelations(
    input.map((item) => ({
      ...item,
      target:
        typeof item.target === "string"
          ? reader.resolve(item.target)
          : reader.resolve(item.target.id, item.target.kind),
    })),
    current,
  );
}

/**
 * Рассчитывает отношения по уже загруженным целям без resolver и I/O.
 * Сохраняет порядок, проверяет дубликаты разрешённых пар и допустимость новой связи.
 */
export function resolvePreparedKnowledgeRelations(
  input: readonly PreparedKnowledgeRelation[],
  current?: KnowledgeRecord<"document">,
): DocumentRelation[] {
  const previous = new Set(
    (current?.data.relations ?? []).map((relation) => `${relation.target.id}:${relation.type}`),
  );
  const seen = new Set<string>();
  return input.map((item) => {
    const target = item.target;
    const pair = `${target.id}:${item.type}`;
    const reference = relationTarget(target, current?.id, previous.has(pair));
    if (seen.has(pair)) {
      invalidKnowledge(knowledgeMessages.duplicateRelation);
    }
    seen.add(pair);
    return { target: reference, type: item.type, description: item.description };
  });
}

/**
 * Вычисляет изменение одной пары цель + тип, сохраняя другие отношения и их порядок.
 * Удаление отсутствующей пары и повтор прежнего описания возвращают равный состав.
 */
export function changeKnowledgeRelation(
  document: KnowledgeRecord<"document">,
  target: KnowledgeReference,
  change: KnowledgeLinkChange,
): DocumentRelation[] {
  const relations = document.data.relations;
  const existing = relations.find(
    (relation) => relation.target.id === target.id && relation.type === change.type,
  );
  const reference = relationTarget(target, document.id, change.remove || existing !== undefined);
  if (change.remove) {
    return relations.filter((relation) => relation !== existing);
  }
  if (existing !== undefined) {
    return relations.map((relation) =>
      relation === existing
        ? { ...relation, description: change.description ?? relation.description }
        : relation,
    );
  }
  if (relations.length >= KNOWLEDGE_LIMITS.relations) {
    invalidKnowledge(knowledgeMessages.relationLimit);
  }
  return [
    ...relations,
    { target: reference, type: change.type, description: change.description ?? "" },
  ];
}
