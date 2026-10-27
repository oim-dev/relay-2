import type { ComponentPropsWithoutRef } from "react";
import type { ProductApplication, ProductFeature, ProductContribution } from "domains/product-demo";

/** Контекст редактирования состава приложения. */
export type ApplicationScopeFormParams = {
  /** Приложение, объявляющее вклад. */
  application: ProductApplication;
  /** Доступные общие фичи и сценарии. */
  features: ProductFeature[];
  /** Подтверждённые вклады приложения. */
  contributions: ProductContribution[];
  /** Ревизия исходного снимка. */
  revision: number;
  /** Область черновика с учётом сброса моков. */
  draftScope: string;
  /** Адрес возврата. */
  backTo: string;
  /** Фича, с которой начато редактирование. */
  initialFeatureId?: string;
  /** Сценарий, с которого начато редактирование. */
  initialScenarioId?: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"form">, "children" | "onSubmit">;
/** Свойства визуальной области. */
export type ApplicationScopeFormProps = RootAttrs & ApplicationScopeFormParams;
