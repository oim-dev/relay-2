import type { ComponentPropsWithoutRef } from "react";
import type { ProductScenario } from "domains/product-demo";

/** Параметры постоянного подраздела сценария. */
export type ScenarioSectionParams = {
  /** Описание и готовность сценария. */
  scenario: ProductScenario;
  /** Адрес родительской фичи. */
  featurePath: string;
  /** Фильтры и раскрытие исходного дерева. */
  search: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "id">;
/** Свойства описания сценария и его действий. */
export type ScenarioSectionProps = RootAttrs & ScenarioSectionParams;
