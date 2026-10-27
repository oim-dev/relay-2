import type { ComponentPropsWithoutRef } from "react";
import type { ProductFeature } from "domains/product-demo";

/** Параметры списка подразделов фичи. */
export type FeatureScenariosParams = {
  /** Фича с полным составом сценариев. */
  feature: ProductFeature;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "id">;
/** Свойства списка сценариев фичи. */
export type FeatureScenariosProps = RootAttrs & FeatureScenariosParams;
