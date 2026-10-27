import type { TreeNodeData } from "@mantine/core";
import type { ScopeTreeFeature, ScopeTreeScenario } from "./scope-tree-props.type";

/** Предметные данные одного узла выбора. */
export type ScopeTreeEntry = {
  /** Родительская фича. */
  feature: ScopeTreeFeature;
  /** Сценарий для второго уровня. */
  scenario?: ScopeTreeScenario;
};
/** Данные представления Mantine Tree. */
export type ScopeTreeData = {
  /** Видимые узлы. */
  nodes: TreeNodeData[];
  /** Записи без приведения типов произвольных nodeProps. */
  entries: Map<string, ScopeTreeEntry>;
};
