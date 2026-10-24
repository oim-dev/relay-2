import { isDeepStrictEqual } from "node:util";
import { RelayError, type CommandEffect, type EntityRecord } from "@relay/contracts";
import { entityCommandEffect } from "../commands/command-entity";
import { KNOWLEDGE_WRITABLE_FIELDS } from "./knowledge-constants";
import { decodeKnowledge, isKnowledgeKind } from "./knowledge-data";
import { requireEmptyProduct } from "./knowledge-rules";
import { knowledgeMessages } from "./knowledge.messages";
import { assertDocumentSectionTransition } from "./document-section-transition";
import type { KnowledgeTransitionContext } from "./knowledge-command.types";

const immutableFields = {
  project: [],
  product: [],
  feature: [],
  scenario: ["featureId"],
  application: ["slug", "prefix", "boardId"],
  implementation: ["applicationId", "featureId", "scenarioId", "targetId", "targetKind"],
  board: ["slug", "prefix", "applicationId"],
  document: [],
} as const;

/**
 * Определяет сохраняемые поля известной операции; legacy replication ограничивается
 * неизменяемой идентичностью связей, а межзаписные правила проверяются отдельными pure владельцами.
 */
function writableTransitionFields(
  next: EntityRecord,
  operation: string,
): readonly string[] | undefined {
  if (!isKnowledgeKind(next.kind) || operation === "replication") {
    return undefined;
  }
  if (operation === `${next.kind}.rename`) {
    return [];
  }
  if (
    operation === `${next.kind}.update` ||
    (operation === "product.create" && next.kind === "product")
  ) {
    return KNOWLEDGE_WRITABLE_FIELDS[next.kind];
  }
  if (next.kind === "project" && operation.startsWith("document.section.")) {
    return ["documentSections", "retiredDocumentSectionIds"];
  }
  if (
    next.kind === "application" &&
    (operation === "implementation.create" || operation === "application.participation.replace")
  ) {
    return ["implementationIds"];
  }
  if (next.kind === "implementation" && operation === "application.participation.replace") {
    return ["active"];
  }
  if (next.kind === "board" && operation === "application.update") {
    return ["name"];
  }
  if (next.kind === "application" && operation === "application.create") {
    return ["boardId"];
  }
  if (
    next.kind === "document" &&
    (operation === "document.link" || operation === "document.unlink")
  ) {
    return ["relations"];
  }
  return [];
}

/**
 * Проверяет эволюцию уже подготовленных before/after без повторного исполнения input,
 * генерации ID/времени и I/O. Канонические записи и final-state связность предоставляет вызывающий.
 * Даже legacy replication не может перепривязать сценарий, FI/SI или доску другого приложения.
 * product.create проверяет пустоту канонического before даже при неизменном after и пустых effects.
 * Единственное заполнение отсутствующего boardId разрешено промежуточному application.create rev1→rev2.
 */
export function assertKnowledgeTransition(
  previous: Readonly<EntityRecord> | null,
  next: Readonly<EntityRecord>,
  context: KnowledgeTransitionContext = { operation: "replication" },
): void {
  if (previous === null || !isKnowledgeKind(next.kind)) {
    return;
  }
  if (context.operation === "product.create" && next.kind === "product") {
    requireEmptyProduct(decodeKnowledge(previous, "product"));
  }
  if (next.kind === "project" && context.operation.startsWith("document.section.")) {
    assertDocumentSectionTransition(
      decodeKnowledge(previous, "project"),
      decodeKnowledge(next, "project"),
      context,
    );
  }
  for (const field of ["id", "kind", "createdAt", "createdBy"] as const) {
    if (previous[field] !== next[field]) {
      throw new RelayError("INVALID_STATE", knowledgeMessages.immutableTransition, 4, {
        id: next.id,
        field,
      });
    }
  }
  if (
    context.operation !== "replication" &&
    context.operation !== `${next.kind}.rename` &&
    previous.key !== next.key
  ) {
    throw new RelayError("INVALID_STATE", knowledgeMessages.immutableTransition, 4, {
      id: next.id,
      field: "key",
    });
  }
  const boardInitialization =
    context.operation === "application.create" &&
    next.kind === "application" &&
    !Object.hasOwn(previous.data, "boardId") &&
    previous.revision === 1 &&
    next.revision === 2;
  for (const field of immutableFields[next.kind]) {
    if (field === "boardId" && boardInitialization) {
      continue;
    }
    if (!isDeepStrictEqual(previous.data[field], next.data[field])) {
      throw new RelayError("INVALID_STATE", knowledgeMessages.immutableTransition, 4, {
        id: next.id,
        field,
      });
    }
  }
  const allowed = writableTransitionFields(next, context.operation);
  if (allowed !== undefined) {
    for (const field of new Set([...Object.keys(previous.data), ...Object.keys(next.data)])) {
      if (!allowed.includes(field) && !isDeepStrictEqual(previous.data[field], next.data[field])) {
        throw new RelayError("INVALID_STATE", knowledgeMessages.immutableTransition, 4, {
          id: next.id,
          field,
        });
      }
    }
  }
}

/**
 * Проверяет общий before→after контракт calculators и incoming, затем выделяет фактический эффект.
 * Для document.section.* targets содержит выбранный ID раздела, включая неизменный результат.
 */
export function knowledgeCommandEffect(
  before: Readonly<EntityRecord> | null,
  after: Readonly<EntityRecord>,
  operation: string,
  targets: Omit<KnowledgeTransitionContext, "operation"> = {},
): readonly CommandEffect[] {
  assertKnowledgeTransition(before, after, { ...targets, operation });
  return entityCommandEffect(before, after);
}
