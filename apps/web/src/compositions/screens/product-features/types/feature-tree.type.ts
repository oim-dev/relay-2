import type { TreeNodeData } from "@mantine/core";
import type { ProductFeature, ProductScenario } from "domains/product-demo";

/** Предметные данные одного узла дерева. */
export type FeatureTreeEntry = {
  /** Полная фича, включая скрытые поиском сценарии. */
  feature: ProductFeature;
  /** Сценарий для узла второго уровня. */
  scenario?: ProductScenario;
  /** Последний видимый сценарий завершает соединительную ветку. */
  isLastScenario?: boolean;
};
/** Проекция каталога на контракт дерева Mantine. */
export type FeatureTreeData = {
  /** Отфильтрованная иерархия. */
  nodes: TreeNodeData[];
  /** Полные данные для отображения и расчёта готовности. */
  entries: Map<string, FeatureTreeEntry>;
};
