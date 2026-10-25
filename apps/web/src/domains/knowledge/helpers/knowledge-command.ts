import type { NamedCommand, ProjectEntity } from "@relay/contracts";
import type { CatalogEntity, CatalogKind, KnowledgeSnapshot } from "../types/knowledge.types";

/**
 * Ограничивает пользовательский параметр маршрута существующим каталогом.
 */
export function catalogKind(value: string | undefined): CatalogKind | undefined {
  switch (value) {
    case "product":
      return "product";
    case "feature":
    case "features":
      return "feature";
    case "scenario":
    case "scenarios":
      return "scenario";
    case "application":
    case "applications":
      return "application";
    case "implementation":
    case "implementations":
      return "implementation";
    default:
      return undefined;
  }
}

/**
 * Сужает карточку к знаниям каталога без потери связи kind/data.
 */
export function isCatalogEntity(entity: ProjectEntity): entity is CatalogEntity {
  return catalogKind(entity.kind) !== undefined;
}

/**
 * Переносит только первоначальные условия CAS; singleton-операции не получают ref.
 */
export function knowledgeGuard(
  snapshot: KnowledgeSnapshot,
  singleton = false,
): Pick<NamedCommand, "ref" | "ifRevision" | "expectedVersion"> {
  return {
    ...(singleton ? {} : { ref: snapshot.entity.id }),
    ifRevision: snapshot.entity.revision,
    ...(snapshot.expectedVersion === undefined
      ? {}
      : { expectedVersion: snapshot.expectedVersion }),
  };
}
