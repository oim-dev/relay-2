/**
 * Граница сохранённых знаний: проверяет полную форму вида и вложения без исправления данных.
 * Ссылочная целостность между записями проверяется предметными сценариями текущего снимка.
 */
import {
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TARGET_KINDS,
  IMPLEMENTATION_STATUSES,
  KNOWLEDGE_KINDS,
  isProjectName,
  type EntityRecord,
  type KnowledgeKind,
  type KnowledgeRecord,
} from "@relay/contracts";
import { KNOWLEDGE_LIMITS, KNOWLEDGE_TEXT_FIELDS } from "./knowledge-constants";
import { KnowledgeDataValidation } from "./knowledge-data-validation";
import type { KnowledgeInput } from "./knowledge.types";

/**
 * Проверяет активные разделы и пожизненный резерв снятых ID проекта.
 */
function validateProjectSections(data: KnowledgeInput, check: KnowledgeDataValidation): void {
  const active = new Set<string>();
  if (Object.hasOwn(data, "documentSections")) {
    for (const value of check.array(
      data.documentSections,
      "documentSections",
      KNOWLEDGE_LIMITS.sections,
    )) {
      const section = check.object(value, "documentSections[]");
      check.fields(section, ["id", "name"], "documentSections[]");
      const id = check.sectionId(section.id, "documentSections[].id");
      if (active.has(id)) {
        check.fail("documentSections[].id");
      }
      active.add(id);
      check.title(section.name, "documentSections[].name");
    }
  }
  if (Object.hasOwn(data, "retiredDocumentSectionIds")) {
    for (const retired of check.identifiers(
      data.retiredDocumentSectionIds,
      "retiredDocumentSectionIds",
    )) {
      check.sectionId(retired, "retiredDocumentSectionIds[]");
      if (active.has(retired)) {
        check.fail("retiredDocumentSectionIds[]");
      }
    }
  }
}

/**
 * Проверяет паспорт проекта и необязательные коллекции разделов без дополнения seed.
 */
function validateProject(data: KnowledgeInput, check: KnowledgeDataValidation): void {
  check.fields(data, ["name", "slug", "documentSections", "retiredDocumentSectionIds"]);
  const name = check.title(data.name, "name");
  if (!isProjectName(name)) {
    check.fail("name");
  }
  check.slug(data.slug);
  validateProjectSections(data, check);
}

/**
 * Проверяет общие тексты знаний; только seed-паспорт допускает отсутствующие поля.
 */
function validateNamedKnowledge(
  kind: "product" | "feature" | "scenario" | "application",
  data: KnowledgeInput,
  check: KnowledgeDataValidation,
): void {
  const extra = {
    product: [],
    feature: [],
    scenario: ["featureId"],
    application: ["slug", "prefix", "type", "boardId", "implementationIds"],
  } as const;
  check.fields(data, [...KNOWLEDGE_TEXT_FIELDS, ...extra[kind]]);
  if (kind !== "product" || Object.hasOwn(data, "name")) {
    check.title(data.name, "name");
  }
  for (const field of ["summary", "description"] as const) {
    if (kind !== "product" || Object.hasOwn(data, field)) {
      check.text(data[field], field);
    }
  }
  if (kind === "scenario") {
    check.id(data.featureId, "featureId");
  }
  if (kind === "application") {
    check.slug(data.slug);
    check.prefix(data.prefix);
    check.choice(data.type, APPLICATION_TYPES, "type");
    check.id(data.boardId, "boardId");
    check.identifiers(data.implementationIds, "implementationIds");
  }
}

/**
 * Проверяет доску; только продуктовая seed-доска допускает отсутствие applicationId.
 */
function validateBoard(data: KnowledgeInput, check: KnowledgeDataValidation): void {
  check.fields(data, ["name", "slug", "prefix", "description", "applicationId"]);
  check.title(data.name, "name");
  check.slug(data.slug);
  check.prefix(data.prefix);
  if (Object.hasOwn(data, "description")) {
    check.text(data.description, "description");
  }
  if (Object.hasOwn(data, "applicationId")) {
    check.id(data.applicationId, "applicationId");
  } else if (data.slug !== "product" || data.prefix !== "PRODUCT") {
    check.fail("applicationId");
  }
}

/**
 * Проверяет содержание реализации и согласованность сохранённых полей цели FI/SI.
 */
function validateImplementation(data: KnowledgeInput, check: KnowledgeDataValidation): void {
  check.fields(data, [
    "title",
    "description",
    "status",
    "active",
    "applicationId",
    "featureId",
    "targetId",
    "targetKind",
    "scenarioId",
  ]);
  check.title(data.title, "title");
  check.text(data.description, "description");
  check.choice(data.status, IMPLEMENTATION_STATUSES, "status");
  if (typeof data.active !== "boolean") {
    check.fail("active");
  }
  for (const field of ["applicationId", "featureId", "targetId"]) {
    check.id(data[field], field);
  }
  check.choice(data.targetKind, ["feature", "scenario"], "targetKind");
  if (data.targetKind === "scenario") {
    check.id(data.scenarioId, "scenarioId");
    if (data.targetId !== data.scenarioId) {
      check.fail("targetId");
    }
  } else if (data.targetId !== data.featureId || Object.hasOwn(data, "scenarioId")) {
    check.fail("targetId");
  }
}

/**
 * Проверяет форму и уникальность отношений документа без загрузки содержания целей.
 */
function validateDocumentRelations(
  value: unknown,
  documentId: string,
  check: KnowledgeDataValidation,
): void {
  const pairs = new Set<string>();
  for (const item of check.array(value, "relations", KNOWLEDGE_LIMITS.relations)) {
    const relation = check.object(item, "relations[]");
    check.fields(relation, ["target", "type", "description"], "relations[]");
    const target = check.object(relation.target, "relations[].target");
    check.fields(target, ["id", "kind"], "relations[].target");
    check.id(target.id, "relations[].target.id");
    check.choice(target.kind, DOCUMENT_TARGET_KINDS, "relations[].target.kind");
    check.choice(relation.type, DOCUMENT_RELATION_TYPES, "relations[].type");
    check.text(relation.description, "relations[].description");
    const pair = JSON.stringify([target.id, relation.type]);
    if (pairs.has(pair) || target.id === documentId) {
      check.fail("relations[].target");
    }
    pairs.add(pair);
  }
}

/**
 * Проверяет полный документ; sectionId здесь проверяется по форме, принадлежность — по проекту.
 */
function validateDocument(
  data: KnowledgeInput,
  documentId: string,
  check: KnowledgeDataValidation,
): void {
  check.fields(data, [
    "name",
    "summary",
    "body",
    "documentKind",
    "documentStatus",
    "sectionId",
    "pinned",
    "relations",
  ]);
  check.title(data.name, "name");
  check.text(data.summary, "summary");
  check.text(data.body, "body", true);
  check.choice(data.documentKind, DOCUMENT_KINDS, "documentKind");
  check.choice(data.documentStatus, DOCUMENT_STATUSES, "documentStatus");
  if (data.sectionId !== null) {
    check.sectionId(data.sectionId, "sectionId");
  }
  if (typeof data.pinned !== "boolean") {
    check.fail("pinned");
  }
  validateDocumentRelations(data.relations, documentId, check);
}

/**
 * Возвращает исходную запись после проверки оболочки и всех полей ожидаемого вида.
 * Не нормализует тексты и не дополняет seed; повреждение вызывает CORRUPT_DATA.
 */
export function decodeKnowledge<K extends KnowledgeKind>(
  record: EntityRecord,
  kind: K,
): KnowledgeRecord<K> {
  const check = new KnowledgeDataValidation(record);
  if (record.kind !== kind) {
    check.fail("kind");
  }
  check.metadata();
  const data = check.object(record.data, "data");
  switch (kind) {
    case "project":
      validateProject(data, check);
      break;
    case "product":
    case "feature":
    case "scenario":
    case "application":
      validateNamedKnowledge(kind, data, check);
      break;
    case "board":
      validateBoard(data, check);
      break;
    case "implementation":
      validateImplementation(data, check);
      break;
    case "document":
      validateDocument(data, record.id, check);
      break;
  }
  // Приведение связывает вид с данными только после полной проверки его схемы и вложений.
  return record as KnowledgeRecord<K>;
}

/**
 * Проверяет принадлежность вида предметной области знаний по общему перечню Contracts.
 */
export function isKnowledgeKind(kind: string): kind is KnowledgeKind {
  return KNOWLEDGE_KINDS.some((variant) => variant === kind);
}
