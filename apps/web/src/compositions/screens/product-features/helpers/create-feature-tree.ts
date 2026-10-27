import { isEmptyArray } from "shared/value-predicates";
import type { ProductFeature } from "domains/product-demo";
import type { FeatureTreeData } from "../types/feature-tree.type";

/**
 * Ищет фичи и сценарии, сохраняя родителя совпадения и полный состав для готовности.
 */
export const createFeatureTree = (features: ProductFeature[], query: string): FeatureTreeData => {
  const treeData: FeatureTreeData = { nodes: [], entries: new Map() };
  for (const feature of features) {
    const matchesFeature = `${feature.key ?? ""} ${feature.name} ${feature.summary}`
      .toLocaleLowerCase("ru")
      .includes(query);
    const scenarios = feature.scenarios.filter(
      (scenario) =>
        matchesFeature ||
        `${scenario.key ?? ""} ${scenario.name} ${scenario.description}`
          .toLocaleLowerCase("ru")
          .includes(query),
    );
    if (!matchesFeature && isEmptyArray(scenarios)) continue;
    treeData.entries.set(feature.id, { feature });
    const children = scenarios.map((scenario, index) => {
      const value = `${feature.id}/${scenario.id}`;
      treeData.entries.set(value, {
        feature,
        scenario,
        isLastScenario: index === scenarios.length - 1,
      });
      return { value, label: scenario.name };
    });
    treeData.nodes.push({ value: feature.id, label: feature.name, children });
  }
  return treeData;
};
