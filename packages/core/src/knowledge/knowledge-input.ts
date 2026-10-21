/**
 * Внешняя граница создания и изменения знаний: проверяет форму и значения без БД.
 * Разрешение ссылок и ограничения сохранённого состояния принадлежат предметным операциям.
 */
import {
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TARGET_KINDS,
  IMPLEMENTATION_STATUSES,
  type DocumentData,
  type FeatureData,
  type KnowledgeKind,
} from "@relay/contracts";
import { KNOWLEDGE_LIMITS, KNOWLEDGE_WRITABLE_FIELDS } from "./knowledge-constants";
import { knowledgeMessages } from "./knowledge.messages";
import type {
  KnowledgeCreation,
  KnowledgeInput,
  KnowledgeLinkChange,
  KnowledgeLinkOptions,
  KnowledgePatchMap,
  KnowledgeRelationInput,
  KnowledgeUpdate,
} from "./knowledge.types";
import {
  invalidKnowledge,
  knowledgeAlias,
  knowledgeBoolean,
  knowledgeChoice,
  knowledgeFields,
  knowledgeName,
  knowledgePrefix,
  knowledgeProjectName,
  knowledgeSlug,
  knowledgeText,
} from "./knowledge-validation";

/**
 * Заполняет обязательные тексты новой фичи, сценария, приложения или паспорта.
 */
function creationTexts(input: KnowledgeInput): FeatureData {
  return {
    name: knowledgeName(input.name),
    summary: Object.hasOwn(input, "summary") ? knowledgeText(input.summary, "summary") : "",
    description: Object.hasOwn(input, "description")
      ? knowledgeText(input.description, "description")
      : "",
  };
}

/**
 * Разбирает только явно переданные общие тексты, не подставляя значений для update.
 */
function changedTexts(input: KnowledgeInput): Partial<FeatureData> {
  return {
    ...(Object.hasOwn(input, "name") ? { name: knowledgeName(input.name) } : {}),
    ...(Object.hasOwn(input, "summary")
      ? { summary: knowledgeText(input.summary, "summary") }
      : {}),
    ...(Object.hasOwn(input, "description")
      ? { description: knowledgeText(input.description, "description") }
      : {}),
  };
}

/**
 * Проверяет форму отношения без загрузки цели; значения по умолчанию задаются здесь.
 */
function relationInput(value: unknown): KnowledgeRelationInput {
  const item = knowledgeFields(
    value,
    ["target", "type", "description"],
    knowledgeMessages.relationLabel,
  );
  let target: KnowledgeRelationInput["target"];
  if (typeof item.target === "string") {
    target = knowledgeText(item.target, "ref", true);
  } else {
    const reference = knowledgeFields(
      item.target,
      ["kind", "id"],
      knowledgeMessages.relationTargetLabel,
    );
    target = {
      id: knowledgeText(reference.id, "target.id", true),
      kind: knowledgeChoice(reference.kind, DOCUMENT_TARGET_KINDS, "target.kind"),
    };
  }
  return {
    target,
    type: Object.hasOwn(item, "type")
      ? knowledgeChoice(item.type, DOCUMENT_RELATION_TYPES, "type")
      : "documents",
    description: Object.hasOwn(item, "description")
      ? knowledgeText(item.description, "description")
      : "",
  };
}

/**
 * Преобразует relations либо сокращённые targets; отсутствие обоих означает пустой список.
 */
function relationInputs(input: KnowledgeInput): KnowledgeRelationInput[] {
  if (Object.hasOwn(input, "relations") && Object.hasOwn(input, "targets")) {
    invalidKnowledge(knowledgeMessages.relationAliases);
  }
  let raw: unknown = [];
  if (Object.hasOwn(input, "relations")) {
    raw = input.relations;
  } else if (Object.hasOwn(input, "targets")) {
    raw = input.targets;
  }
  if (!Array.isArray(raw)) {
    invalidKnowledge(knowledgeMessages.relationsArray);
  }
  if (raw.length > KNOWLEDGE_LIMITS.relations) {
    invalidKnowledge(knowledgeMessages.relationLimit);
  }
  if (Object.hasOwn(input, "targets")) {
    return Array.from(raw, (ref: unknown) => ({
      target: knowledgeText(ref, "targets", true),
      type: "documents",
      description: "",
    }));
  }
  return Array.from(raw, relationInput);
}

/**
 * Проверяет явно переданное содержание документа; связи разбираются отдельно.
 */
function documentPatch(input: KnowledgeInput): KnowledgePatchMap["document"] {
  let sectionId: string | null | undefined;
  if (Object.hasOwn(input, "sectionId")) {
    sectionId = input.sectionId === null ? null : knowledgeText(input.sectionId, "sectionId", true);
  }
  return {
    ...(Object.hasOwn(input, "name") ? { name: knowledgeName(input.name) } : {}),
    ...(Object.hasOwn(input, "summary")
      ? { summary: knowledgeText(input.summary, "summary") }
      : {}),
    ...(Object.hasOwn(input, "body") ? { body: knowledgeText(input.body, "body", true) } : {}),
    ...(Object.hasOwn(input, "documentKind")
      ? { documentKind: knowledgeChoice(input.documentKind, DOCUMENT_KINDS, "documentKind") }
      : {}),
    ...(Object.hasOwn(input, "documentStatus")
      ? {
          documentStatus: knowledgeChoice(
            input.documentStatus,
            DOCUMENT_STATUSES,
            "documentStatus",
          ),
        }
      : {}),
    ...(Object.hasOwn(input, "pinned") ? { pinned: knowledgeBoolean(input.pinned, "pinned") } : {}),
    ...(sectionId === undefined ? {} : { sectionId }),
  };
}

/**
 * Формирует полный документ с сохранением пустой аннотации и отсутствия раздела.
 */
function documentCreation(input: KnowledgeInput): Omit<DocumentData, "relations"> {
  const patch = documentPatch(input);
  return {
    name: knowledgeName(input.name),
    body: knowledgeText(input.body, "body", true),
    summary: patch.summary ?? "",
    documentKind: patch.documentKind ?? "description",
    documentStatus: patch.documentStatus ?? "draft",
    pinned: patch.pinned ?? false,
    sectionId: patch.sectionId ?? null,
  };
}

/**
 * Разбирает команду создания, сохраняя связь вида знания с допустимым содержанием.
 * Проект и доска создаются только своими владельцами и здесь отклоняются.
 */
export function parseKnowledgeCreation(kind: KnowledgeKind, value: unknown): KnowledgeCreation {
  const extra = {
    scenario: ["feature", "featureId"],
    application: ["slug", "prefix"],
    implementation: ["application", "applicationId", "target"],
  } as const;
  if (kind === "project") {
    invalidKnowledge(knowledgeMessages.projectCreation);
  }
  if (kind === "board") {
    invalidKnowledge(knowledgeMessages.boardCreation);
  }
  const additional =
    kind === "scenario" || kind === "application" || kind === "implementation" ? extra[kind] : [];
  const input = knowledgeFields(value, [...KNOWLEDGE_WRITABLE_FIELDS[kind], ...additional]);
  switch (kind) {
    case "product":
    case "feature":
      return { kind, data: creationTexts(input) };
    case "scenario":
      return {
        kind,
        data: creationTexts(input),
        feature: knowledgeText(knowledgeAlias(input, "feature", "featureId"), "feature", true),
      };
    case "application": {
      const slug = knowledgeSlug(input.slug);
      return {
        kind,
        data: {
          ...creationTexts(input),
          slug,
          prefix: knowledgePrefix(
            Object.hasOwn(input, "prefix") ? input.prefix : slug.toUpperCase(),
          ),
          type: Object.hasOwn(input, "type")
            ? knowledgeChoice(input.type, APPLICATION_TYPES, "type")
            : "frontend",
        },
      };
    }
    case "implementation":
      return {
        kind,
        data: {
          title: knowledgeName(input.title, "title"),
          description: Object.hasOwn(input, "description")
            ? knowledgeText(input.description, "description")
            : "",
          status: Object.hasOwn(input, "status")
            ? knowledgeChoice(input.status, IMPLEMENTATION_STATUSES, "status")
            : "none",
        },
        application: knowledgeText(
          knowledgeAlias(input, "application", "applicationId"),
          "application",
          true,
        ),
        target: knowledgeText(input.target, "target", true),
      };
    case "document":
      return { kind, data: documentCreation(input), relations: relationInputs(input) };
  }
}

/**
 * Разбирает непустое изменение без разрешения ссылок и без применения no-op.
 * Вызывающий сценарий проверяет ревизию владельца до этой функции.
 */
export function parseKnowledgeUpdate(
  kind: Exclude<KnowledgeKind, "board">,
  value: unknown,
): KnowledgeUpdate {
  const input = knowledgeFields(value, KNOWLEDGE_WRITABLE_FIELDS[kind]);
  if (Object.keys(input).length === 0) {
    invalidKnowledge(knowledgeMessages.emptyUpdate);
  }
  switch (kind) {
    case "project":
      return {
        kind,
        data: {
          ...(Object.hasOwn(input, "name") ? { name: knowledgeProjectName(input.name) } : {}),
          ...(Object.hasOwn(input, "slug") ? { slug: knowledgeSlug(input.slug) } : {}),
        },
      };
    case "product":
    case "feature":
    case "scenario":
      return { kind, data: changedTexts(input) };
    case "application":
      return {
        kind,
        data: {
          ...changedTexts(input),
          ...(Object.hasOwn(input, "type")
            ? { type: knowledgeChoice(input.type, APPLICATION_TYPES, "type") }
            : {}),
        },
      };
    case "implementation":
      return {
        kind,
        data: {
          ...(Object.hasOwn(input, "title") ? { title: knowledgeName(input.title, "title") } : {}),
          ...(Object.hasOwn(input, "description")
            ? { description: knowledgeText(input.description, "description") }
            : {}),
          ...(Object.hasOwn(input, "status")
            ? { status: knowledgeChoice(input.status, IMPLEMENTATION_STATUSES, "status") }
            : {}),
        },
      };
    case "document":
      return {
        kind,
        data: documentPatch(input),
        ...(Object.hasOwn(input, "relations") || Object.hasOwn(input, "targets")
          ? { relations: relationInputs(input) }
          : {}),
      };
  }
}

/**
 * Проверяет поля изменения одной пары отношения; описание запрещено при снятии.
 */
export function parseKnowledgeLink(write: KnowledgeLinkOptions): KnowledgeLinkChange {
  const remove = Object.hasOwn(write, "remove") ? knowledgeBoolean(write.remove, "remove") : false;
  const type = Object.hasOwn(write, "type")
    ? knowledgeChoice(write.type, DOCUMENT_RELATION_TYPES, "type")
    : "documents";
  const description = Object.hasOwn(write, "description")
    ? knowledgeText(write.description, "description")
    : undefined;
  if (remove && description !== undefined) {
    invalidKnowledge(knowledgeMessages.unlinkDescription);
  }
  return { remove, type, ...(description === undefined ? {} : { description }) };
}

/**
 * Проверяет массив ссылок состава; дубликаты разрешённых целей проверяются позднее.
 */
export function parseParticipationTargets(value: unknown): string[] {
  if (!Array.isArray(value)) {
    invalidKnowledge(knowledgeMessages.targetsArray);
  }
  return Array.from(value, (ref: unknown) => knowledgeText(ref, "targets", true));
}
