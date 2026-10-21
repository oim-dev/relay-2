/**
 * Правила ревизии и состава участия над уже проверенными данными; обращения к БД отсутствуют.
 */
import { RelayError, type EntityRecord, type KnowledgeRecord } from "@relay/contracts";
import type { ImplementationTarget, KnowledgeReference } from "./knowledge.types";
import { KNOWLEDGE_TEXT_FIELDS } from "./knowledge-constants";
import { knowledgeMessages } from "./knowledge.messages";
import { invalidKnowledge } from "./knowledge-validation";

/**
 * Проверяет ревизию владельца до вычисления no-op и любых предметных записей.
 */
export function requireKnowledgeRevision(entity: EntityRecord, expected: number): void {
  if (entity.revision !== expected) {
    throw new RelayError("REVISION_CONFLICT", knowledgeMessages.revision(entity.key), 4, {
      id: entity.id,
      expectedRevision: expected,
      actualRevision: entity.revision,
    });
  }
}

/**
 * Сравнивает упорядоченные JSON-коллекции отношений, разделов или состава участия.
 */
export function sameKnowledgeCollection<T>(left: readonly T[], right: readonly T[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Разрешает одноразовое создание паспорта только пока все его тексты пусты или отсутствуют.
 */
export function requireEmptyProduct(product: KnowledgeRecord<"product">): void {
  if (KNOWLEDGE_TEXT_FIELDS.some((field) => (product.data[field]?.length ?? 0) > 0)) {
    throw new RelayError("ALREADY_EXISTS", knowledgeMessages.productExists, 4);
  }
}

/**
 * Ограничивает уже декодированную цель реализации фичей или сценарием.
 */
export function requireImplementationTarget(record: KnowledgeReference): ImplementationTarget {
  if (record.kind !== "feature" && record.kind !== "scenario") {
    invalidKnowledge(knowledgeMessages.targetRequired);
  }
  return record;
}

/**
 * Проверяет уникальность целей и наличие FI фичи для каждого выбранного SI.
 */
export function requireParticipationSelection(targets: readonly ImplementationTarget[]): void {
  const selectedIds = new Set(targets.map((target) => target.id));
  if (selectedIds.size !== targets.length) {
    invalidKnowledge(knowledgeMessages.duplicateParticipation);
  }
  for (const target of targets) {
    if (target.kind === "scenario" && !selectedIds.has(target.data.featureId)) {
      invalidKnowledge(knowledgeMessages.missingSelectedFeature);
    }
  }
}

/**
 * Запрещает отдельное создание SI без активной FI той же фичи в приложении.
 * existing содержит только реализации данного приложения из одного снимка операции.
 */
export function requireFeatureParticipation(
  target: ImplementationTarget,
  existing: readonly KnowledgeRecord<"implementation">[],
): void {
  if (
    target.kind === "scenario" &&
    !existing.some((record) => record.data.targetId === target.data.featureId && record.data.active)
  ) {
    invalidKnowledge(knowledgeMessages.missingActiveFeature);
  }
}
