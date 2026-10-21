import {
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TARGET_KINDS,
  IMPLEMENTATION_STATUSES,
  KNOWLEDGE_KINDS,
  RelayError,
  validateActor,
  type EntityRecord,
  type KnowledgeKind,
  type KnowledgeRecord,
} from "@relay/contracts";

/** Граница чтения знаний: проверяет сохранённую форму, не исправляет и не дополняет данные. */
export function decodeKnowledge<K extends KnowledgeKind>(
  record: EntityRecord,
  kind: K,
): KnowledgeRecord<K> {
  const fail = (field: string): never => {
    throw new RelayError("CORRUPT_DATA", `Повреждены данные ${record.key}: ${field}.`, 1, {
      id: record.id,
      kind: record.kind,
      field,
    });
  };
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(field);
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, field: string, nonempty = false): string => {
    if (typeof value !== "string" || (nonempty && !value.trim())) fail(field);
    return value as string;
  };
  const title = (value: unknown, field: string): string => {
    const result = text(value, field, true);
    if (/[\r\n\u2028\u2029]/u.test(result)) fail(field);
    return result;
  };
  const id = (value: unknown, field: string): string => {
    const result = text(value, field, true);
    if (result !== result.trim() || /[\p{Cc}\u2028\u2029]/u.test(result)) fail(field);
    return result;
  };
  const sectionId = (value: unknown, field: string): string => {
    const result = id(value, field);
    if (result.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(result)) fail(field);
    return result;
  };
  const choice = (value: unknown, variants: readonly string[], field: string): void => {
    if (typeof value !== "string" || !variants.includes(value)) fail(field);
  };
  const array = (value: unknown, field: string, max = Infinity): unknown[] => {
    if (!Array.isArray(value) || value.length > max) fail(field);
    return value as unknown[];
  };
  const identifiers = (value: unknown, field: string, max = Infinity): string[] => {
    const result = Array.from(array(value, field, max), (item) => id(item, field));
    if (new Set(result).size !== result.length) fail(field);
    return result;
  };
  const slug = (value: unknown): void => {
    const result = text(value, "slug");
    if (result.length < 2 || result.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result))
      fail("slug");
  };
  const prefix = (value: unknown): void => {
    const result = text(value, "prefix");
    if (result.length > 32 || !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u.test(result)) fail("prefix");
  };
  const fields = (
    value: Record<string, unknown>,
    allowed: readonly string[],
    path = "data",
  ): void => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`);
  };

  if (record.kind !== kind) fail("kind");
  id(record.id, "id");
  id(record.key, "key");
  if (/[\s:]/u.test(record.key)) fail("key");
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) fail("revision");
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (!Number.isFinite(Date.parse(text(record[field], field)))) fail(field);
  }
  const data = object(record.data, "data");
  for (const field of ["createdBy", "updatedBy"] as const) {
    try {
      validateActor(record[field]);
    } catch (error) {
      if (!(error instanceof RelayError)) throw error;
      fail(field);
    }
  }
  switch (kind) {
    case "project": {
      fields(data, ["name", "slug", "documentSections", "retiredDocumentSectionIds"]);
      const name = title(data.name, "name");
      if (name !== name.trim() || name.length > 120 || /\p{Cc}/u.test(name)) fail("name");
      slug(data.slug);
      const active = new Set<string>();
      if (Object.hasOwn(data, "documentSections")) {
        for (const value of array(data.documentSections, "documentSections", 100)) {
          const section = object(value, "documentSections[]");
          fields(section, ["id", "name"], "documentSections[]");
          const selected = sectionId(section.id, "documentSections[].id");
          if (active.has(selected)) fail("documentSections[].id");
          active.add(selected);
          title(section.name, "documentSections[].name");
        }
      }
      if (Object.hasOwn(data, "retiredDocumentSectionIds")) {
        for (const retired of identifiers(
          data.retiredDocumentSectionIds,
          "retiredDocumentSectionIds",
        )) {
          sectionId(retired, "retiredDocumentSectionIds[]");
          if (active.has(retired)) fail("retiredDocumentSectionIds[]");
        }
      }
      break;
    }
    case "product":
    case "feature":
    case "scenario":
    case "application": {
      fields(data, [
        "name",
        "summary",
        "description",
        ...(kind === "scenario" ? ["featureId"] : []),
        ...(kind === "application"
          ? ["slug", "prefix", "type", "boardId", "implementationIds"]
          : []),
      ]);
      if (kind !== "product" || Object.hasOwn(data, "name")) title(data.name, "name");
      for (const field of ["summary", "description"] as const) {
        if (kind !== "product" || Object.hasOwn(data, field)) text(data[field], field);
      }
      if (kind === "scenario") id(data.featureId, "featureId");
      if (kind === "application") {
        slug(data.slug);
        prefix(data.prefix);
        choice(data.type, APPLICATION_TYPES, "type");
        id(data.boardId, "boardId");
        identifiers(data.implementationIds, "implementationIds");
      }
      break;
    }
    case "board":
      fields(data, ["name", "slug", "prefix", "description", "applicationId"]);
      title(data.name, "name");
      slug(data.slug);
      prefix(data.prefix);
      if (Object.hasOwn(data, "description")) text(data.description, "description");
      if (Object.hasOwn(data, "applicationId")) id(data.applicationId, "applicationId");
      else if (data.slug !== "product" || data.prefix !== "PRODUCT") fail("applicationId");
      break;
    case "implementation":
      fields(data, [
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
      title(data.title, "title");
      text(data.description, "description");
      choice(data.status, IMPLEMENTATION_STATUSES, "status");
      if (typeof data.active !== "boolean") fail("active");
      for (const field of ["applicationId", "featureId", "targetId"]) id(data[field], field);
      choice(data.targetKind, ["feature", "scenario"], "targetKind");
      if (data.targetKind === "scenario") {
        id(data.scenarioId, "scenarioId");
        if (data.targetId !== data.scenarioId) fail("targetId");
      } else if (data.targetId !== data.featureId || Object.hasOwn(data, "scenarioId"))
        fail("targetId");
      break;
    case "document": {
      fields(data, [
        "name",
        "summary",
        "body",
        "documentKind",
        "documentStatus",
        "sectionId",
        "pinned",
        "relations",
      ]);
      title(data.name, "name");
      text(data.summary, "summary");
      text(data.body, "body", true);
      choice(data.documentKind, DOCUMENT_KINDS, "documentKind");
      choice(data.documentStatus, DOCUMENT_STATUSES, "documentStatus");
      if (data.sectionId !== null) sectionId(data.sectionId, "sectionId");
      if (typeof data.pinned !== "boolean") fail("pinned");
      const pairs = new Set<string>();
      for (const value of array(data.relations, "relations", 100)) {
        const relation = object(value, "relations[]");
        fields(relation, ["target", "type", "description"], "relations[]");
        const target = object(relation.target, "relations[].target");
        fields(target, ["id", "kind"], "relations[].target");
        id(target.id, "relations[].target.id");
        choice(target.kind, DOCUMENT_TARGET_KINDS, "relations[].target.kind");
        choice(relation.type, DOCUMENT_RELATION_TYPES, "relations[].type");
        text(relation.description, "relations[].description");
        const pair = JSON.stringify([target.id, relation.type]);
        if (pairs.has(pair) || target.id === record.id) fail("relations[].target");
        pairs.add(pair);
      }
      break;
    }
  }
  // Приведение стоит только после проверки всех полей соответствующего вида, включая вложения.
  return record as KnowledgeRecord<K>;
}

export function isKnowledgeKind(kind: string): kind is KnowledgeKind {
  return (KNOWLEDGE_KINDS as readonly string[]).includes(kind);
}
