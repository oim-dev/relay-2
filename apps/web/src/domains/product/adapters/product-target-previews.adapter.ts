import { getProductEntities } from "./product-entities.adapter";
import { getProductTargetOptions } from "../helpers/context-options";
import type { ProductTargetPreview } from "../types/product-target-preview.type";

/**
 * Читает адресный набор одного поколения. Порциями и проверкой generation
 * владеет общий продуктовый адаптер, а не независимые чтения этого списка.
 */
export const getProductTargetPreviews = async (
  projectId: string,
  targetIds: string[],
): Promise<Map<string, ProductTargetPreview>> => {
  const targetsById = new Map<string, ProductTargetPreview>();
  const page = await getProductEntities(projectId, { refs: targetIds });
  for (const target of getProductTargetOptions(page.items)) {
    targetsById.set(target.id, {
      id: target.id,
      title: target.title,
      label: target.kind,
      requirementKind: target.requirementKind,
      isActive: target.isActive,
    });
  }
  return targetsById;
};
