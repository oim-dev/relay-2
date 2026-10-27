import type { ComponentPropsWithoutRef } from "react";
import type { ProductWork } from "domains/product-demo";

/** Контекст одного плана. */
export type WorkPlanParams = {
  /** План. */
  plan: ProductWork;
  /** Связанные этапы. */
  stages: ProductWork[];
  /** Связанные задачи. */
  tasks: ProductWork[];
  /** Адрес исходной карточки. */
  returnTo: string;
};
/** Атрибуты области плана. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"article">, "children">;
/** Свойства плана реализации. */
export type WorkPlanProps = RootAttrs & WorkPlanParams;
