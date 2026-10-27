import type { ComponentPropsWithoutRef } from "react";
import type { ProductStatus } from "domains/product-demo";

/** Проекция сценария для выбора. */
export type ScopeTreeScenario = {
  /** Постоянный ID сценария. */
  id: string;
  /** Название общего сценария. */
  name: string;
  key?: string;
  /** Включён ли он в состав приложения. */
  isEnabled: boolean;
  /** Описан ли вклад. */
  hasDescription: boolean;
  /** Готовность вклада приложения. */
  status: ProductStatus;
};
/** Проекция фичи с независимым выбором её сценариев. */
export type ScopeTreeFeature = ScopeTreeScenario & {
  /** Доступные сценарии. */
  scenarios: ScopeTreeScenario[];
};

/** Контракт выбора состава приложения. */
export type ScopeTreeParams = {
  /** Каталог с текущим выбором формы. */
  items: ScopeTreeFeature[];
  /** Фича открытого редактора. */
  activeFeatureId?: string;
  /** Сценарий открытого редактора. */
  activeScenarioId?: string;
  /** Открывает описание, не меняя включение в состав. */
  onInspect: (featureId: string, scenarioId?: string) => void;
  /** Включает либо исключает фичу или сценарий. */
  onToggle: (featureId: string, scenarioId: string | undefined, isEnabled: boolean) => void;
  /** Включает все сценарии одной фичи. */
  onSelectAll: (featureId: string) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children" | "onToggle">;
/** Свойства визуальной области. */
export type ScopeTreeProps = RootAttrs & ScopeTreeParams;
