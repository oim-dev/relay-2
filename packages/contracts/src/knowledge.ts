import type { EntityRecord } from "./index";

export const KNOWLEDGE_KINDS = [
  "project",
  "product",
  "feature",
  "scenario",
  "application",
  "implementation",
  "document",
  "board",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const APPLICATION_TYPES = ["frontend", "backend", "internal"] as const;
export const IMPLEMENTATION_STATUSES = ["none", "partial", "done"] as const;
export const DOCUMENT_KINDS = [
  "specification",
  "description",
  "rules",
  "instruction",
  "proposal",
  "decision",
  "research",
] as const;
export const DOCUMENT_STATUSES = ["draft", "active", "archived"] as const;
export const DOCUMENT_RELATION_TYPES = ["documents", "references"] as const;
export const DOCUMENT_TARGET_KINDS = [...KNOWLEDGE_KINDS, "task", "work-plan", "release"] as const;

export type DocumentSection = { id: string; name: string };
export type DocumentRelation = {
  target: { kind: (typeof DOCUMENT_TARGET_KINDS)[number]; id: string };
  type: (typeof DOCUMENT_RELATION_TYPES)[number];
  description: string;
};
export type ProjectData = {
  name: string;
  slug: string;
  /** Отсутствует у нового проекта до первой операции с разделами; null не допускается. */
  documentSections?: DocumentSection[];
  retiredDocumentSectionIds?: string[];
};
/** Паспорт при инициализации пуст; update допускает независимое заполнение текстовых полей. */
export type ProductData = { name?: string; summary?: string; description?: string };
export type FeatureData = { name: string; summary: string; description: string };
export type ScenarioData = FeatureData & { featureId: string };
export type ApplicationData = FeatureData & {
  slug: string;
  prefix: string;
  type: (typeof APPLICATION_TYPES)[number];
  boardId: string;
  implementationIds: string[];
};
export type BoardData = {
  name: string;
  slug: string;
  prefix: string;
  /** У продуктовой seed-доски описание и applicationId отсутствуют. */
  description?: string;
  applicationId?: string;
};
export type ImplementationData = {
  title: string;
  description: string;
  status: (typeof IMPLEMENTATION_STATUSES)[number];
  active: boolean;
  applicationId: string;
  featureId: string;
  targetId: string;
} & (
  { targetKind: "feature"; scenarioId?: never } | { targetKind: "scenario"; scenarioId: string }
);
export type DocumentData = {
  name: string;
  summary: string;
  body: string;
  documentKind: (typeof DOCUMENT_KINDS)[number];
  documentStatus: (typeof DOCUMENT_STATUSES)[number];
  sectionId: string | null;
  pinned: boolean;
  relations: DocumentRelation[];
};

export type KnowledgeDataMap = {
  project: ProjectData;
  product: ProductData;
  feature: FeatureData;
  scenario: ScenarioData;
  application: ApplicationData;
  implementation: ImplementationData;
  document: DocumentData;
  board: BoardData;
};

/** Проверенная запись Core; EntityRecord остаётся сырым контрактом хранения. */
export type KnowledgeRecord<K extends KnowledgeKind = KnowledgeKind> = {
  [P in K]: Omit<EntityRecord, "kind" | "data"> & { kind: P; data: KnowledgeDataMap[P] };
}[K];

export type DocumentSections = { project: string; revision: number; items: DocumentSection[] };
export type DocumentLinks = { ref: string; revision: number; items: DocumentRelation[] };
