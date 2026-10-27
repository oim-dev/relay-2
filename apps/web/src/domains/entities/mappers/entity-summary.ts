import type { ProjectEntity } from "@relay/contracts";
import type { EntitySummary } from "../types/entity-summary.type";

/**
 * Переводит проверенный SDK DTO в карточку, не вычисляя предметную готовность.
 */
export function toEntitySummary(entity: ProjectEntity): EntitySummary {
  const data = entity.data;
  const title = "name" in data ? data.name : "title" in data ? data.title : entity.key;
  const status = "status" in data ? data.status : "column" in data ? data.column : undefined;
  return {
    ref: { kind: entity.kind, id: entity.id },
    key: entity.key,
    title: typeof title === "string" ? title : entity.key,
    summary: "summary" in data && typeof data.summary === "string" ? data.summary : "",
    revision: entity.revision,
    ...(typeof status === "string" ? { status } : {}),
    active: entity.kind === "implementation" ? entity.data.active : true,
    ...(entity.kind === "document"
      ? {
          status: entity.data.documentStatus,
          document: {
            kind: entity.data.documentKind,
            status: entity.data.documentStatus,
            sectionId: entity.data.sectionId,
            pinned: entity.data.pinned,
            updatedAt: entity.updatedAt,
            linkCount: entity.data.relations.length,
          },
        }
      : {}),
  };
}
