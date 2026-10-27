import type { ProductSnapshot } from "../types/product-demo.type";
import type { ProductDocumentation } from "../types/documentation.type";

/**
 * Возвращает документы с прямой связью с одной из указанных областей.
 */
export const getRelatedDocuments = (
  snapshot: ProductSnapshot,
  scopeIds: string[],
): ProductDocumentation[] =>
  snapshot.documentation.filter((document) =>
    document.scopeIds.some((id) => scopeIds.includes(id)),
  );
