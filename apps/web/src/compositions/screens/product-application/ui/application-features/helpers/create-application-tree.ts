import type { ProductContribution, ProductFeature } from "domains/product-demo";
import type { ApplicationTreeData } from "../types/application-tree.type";

/**
 * Преобразует выбранный состав в те же два уровня, что и общий каталог продукта.
 */
export const createApplicationTree = (
  features: ProductFeature[],
  contributions: ProductContribution[],
): ApplicationTreeData => {
  const treeData: ApplicationTreeData = { nodes: [], entries: new Map() };
  for (const contribution of contributions) {
    const feature = features.find((entry) => entry.id === contribution.featureId);
    if (feature === undefined) continue;
    treeData.entries.set(feature.id, { feature, contribution });
    const scenarios = contribution.scenarios.flatMap((entry) => {
      const source = feature.scenarios.find((scenario) => scenario.id === entry.scenarioId);
      return source === undefined ? [] : [{ ...entry, name: source.name }];
    });
    const children = scenarios.map((scenario, index) => {
      const value = `${feature.id}/${scenario.scenarioId}`;
      treeData.entries.set(value, {
        feature,
        contribution,
        scenario,
        isLastScenario: index === scenarios.length - 1,
      });
      return { value, label: scenario.name };
    });
    treeData.nodes.push({ value: feature.id, label: feature.name, children });
  }
  return treeData;
};
