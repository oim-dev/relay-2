/**
 * Виды знаний проекта, доступные через единый сервис знаний Core.
 */
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

/**
 * Назначение приложения в составе продукта.
 */
export const APPLICATION_TYPES = ["frontend", "backend", "internal"] as const;

/**
 * Степени реализации функциональности или сценария в приложении.
 */
export const IMPLEMENTATION_STATUSES = ["none", "partial", "done"] as const;

/**
 * Предметные виды документов, независимо от их состояния и раздела.
 */
export const DOCUMENT_KINDS = [
  "specification",
  "description",
  "rules",
  "instruction",
  "proposal",
  "decision",
  "research",
] as const;

/**
 * Состояния документа от черновика до архива.
 */
export const DOCUMENT_STATUSES = ["draft", "active", "archived"] as const;

/**
 * Значения отношения документа к цели: документирование либо ссылка.
 */
export const DOCUMENT_RELATION_TYPES = ["documents", "references"] as const;

/**
 * Виды целей структурированных отношений документов.
 */
export const DOCUMENT_TARGET_KINDS = [...KNOWLEDGE_KINDS, "task", "work-plan", "release"] as const;
