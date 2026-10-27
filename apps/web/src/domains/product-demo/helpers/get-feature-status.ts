import type { ProductFeature, ProductStatus } from "../types/product-demo.type";

/**
 * Возвращает доступную проекцию; текущий Core не выдаёт готовность требований.
 * Отсутствие значения не превращается в «не реализовано».
 */
export const getFeatureStatus = (feature: ProductFeature): ProductStatus | undefined => {
  return feature.status;
};
