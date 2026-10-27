import type { TreeNodeData } from "@mantine/core";
import type { ProductContribution, ProductFeature } from "domains/product-demo";

/** Вклад сценария с исходным названием. */
export type ApplicationScenarioRow = ProductContribution["scenarios"][number] & {
  /** Имя общего сценария. */
  name: string;
};
/** Запись одного узла дерева приложения. */
export type ApplicationTreeEntry = {
  /** Исходная фича. */
  feature: ProductFeature;
  /** Вклад приложения в фичу. */
  contribution: ProductContribution;
  /** Выбранный сценарий с собственным вкладом. */
  scenario?: ApplicationScenarioRow;
  /** Последний сценарий завершает ветку. */
  isLastScenario?: boolean;
};
/** Представление состава в Mantine Tree. */
export type ApplicationTreeData = {
  /** Иерархия фич и выбранных сценариев. */
  nodes: TreeNodeData[];
  /** Записи для общего компонента строки. */
  entries: Map<string, ApplicationTreeEntry>;
};
