import type { RenderTreeNodePayload } from "@mantine/core";
import type { ProductFeature, ProductScenario } from "domains/product-demo";

/** Параметры строки фичи. */
export type FeatureRowParams = {
  /** Возможность продукта. */
  feature: ProductFeature;
  /** Сценарий для дочернего узла. */
  scenario?: ProductScenario;
  /** Завершает линию на последнем видимом сценарии. */
  isLastScenario?: boolean;
  /** Управление раскрытием и атрибуты узла от Mantine. */
  payload: RenderTreeNodePayload;
  /** Исходные фильтры. */
  search: string;
};
/** Свойства строки. */
export type FeatureRowProps = FeatureRowParams;
