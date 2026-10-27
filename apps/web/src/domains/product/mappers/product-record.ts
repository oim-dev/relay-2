import type { ProjectEntity } from "@relay/contracts";
import type { ProductEntity, ProductEntitySummary } from "../types/product-entity.type";
import type { ProductState, ProductLink } from "../types/product.type";

/**
 * Адаптирует проверенное содержание Core без вычисления готовности требований.
 */
export function toProductEntity(entity: ProjectEntity): ProductEntity {
  const base = {
    id: entity.id,
    key: entity.key,
    canonicalRef: entity.id,
    revision: entity.revision,
    updatedAt: entity.updatedAt,
  };
  switch (entity.kind) {
    case "product":
      return {
        ...base,
        fields: {
          kind: "passport",
          name: entity.data.name ?? "",
          summary: entity.data.summary ?? "",
          description: entity.data.description ?? "",
        },
      };
    case "feature":
      return { ...base, fields: { kind: "feature", ...entity.data } };
    case "scenario":
      return { ...base, fields: { kind: "scenario", ...entity.data } };
    case "application":
      return { ...base, fields: { kind: "application", ...entity.data } };
    case "implementation":
      return {
        ...base,
        fields: {
          kind: "implementation",
          applicationId: entity.data.applicationId,
          featureId: entity.data.featureId,
          scenarioId: entity.data.scenarioId ?? null,
          title: entity.data.title,
          description: entity.data.description,
          status: entity.data.status,
          active: entity.data.active,
        },
      };
    case "document":
      return {
        ...base,
        fields: {
          kind: "document",
          name: entity.data.name,
          summary: entity.data.summary,
          body: entity.data.body,
          documentKind: entity.data.documentKind,
          links: entity.data.relations.flatMap<ProductLink>((link) => {
            const { kind, id } = link.target;
            if (kind === "product") return [{ kind: "product" as const }];
            if (kind === "feature" || kind === "scenario" || kind === "application")
              return [{ kind, id }];
            return [];
          }),
        },
      };
    default:
      throw new Error("Запись не относится к продуктовому каталогу.");
  }
}

/**
 * Формирует совместимый снимок экранов. Состав — проекция приложения-владельца,
 * реализации сохраняют собственные ревизии и независимые status/active.
 */
export function toProductState(
  project: string,
  generation: number,
  entities: ProjectEntity[],
): ProductState {
  const records: ProductState["records"] = [];
  for (const entity of entities) {
    if (entity.kind === "implementation") continue;
    const view = toProductEntity(entity);
    if (view.fields.kind === "implementation") continue;
    records.push({ ...view, fields: view.fields, createdAt: entity.createdAt });
    if (entity.kind === "application") {
      const contracts = entities.flatMap((implementation) => {
        if (
          implementation.kind !== "implementation" ||
          implementation.data.applicationId !== entity.id
        )
          return [];
        return [
          {
            id: implementation.id,
            key: implementation.key,
            revision: implementation.revision,
            featureId: implementation.data.featureId,
            scenarioId: implementation.data.scenarioId ?? null,
            title: implementation.data.title,
            description: implementation.data.description,
            status: implementation.data.status,
            active: implementation.data.active,
          },
        ];
      });
      records.push({
        id: `scope:${entity.id}`,
        revision: entity.revision,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        fields: { kind: "scope", applicationId: entity.id, contracts },
      });
    }
  }
  return { productId: project, version: String(generation), records };
}

/**
 * Краткий продуктовый контекст. Названия родителей берутся из того же набора DTO.
 */
export function toProductSummary(
  entity: ProjectEntity,
  related: ReadonlyMap<string, ProjectEntity>,
): ProductEntitySummary {
  const view = toProductEntity(entity);
  const fields = view.fields;
  const implementation = entity.kind === "implementation" ? entity.data : undefined;
  const application = implementation ? related.get(implementation.applicationId) : undefined;
  const featureId = "featureId" in fields ? fields.featureId : null;
  const targetId = implementation?.targetId ?? featureId;
  const target = targetId ? related.get(targetId) : undefined;
  return {
    id: entity.id,
    key: entity.key,
    kind: fields.kind === "scope" ? "application" : fields.kind,
    title: "name" in fields ? fields.name : "title" in fields ? fields.title : entity.key,
    summary: "summary" in fields ? fields.summary : "",
    revision: entity.revision,
    applicationId: implementation?.applicationId ?? null,
    applicationKey: application?.key ?? null,
    applicationName: application?.kind === "application" ? application.data.name : null,
    featureId,
    scenarioId: implementation?.scenarioId ?? null,
    targetKey: target?.key ?? null,
    targetName: target?.kind === "feature" || target?.kind === "scenario" ? target.data.name : null,
    active: implementation?.active ?? true,
    status: implementation?.status ?? null,
  };
}
