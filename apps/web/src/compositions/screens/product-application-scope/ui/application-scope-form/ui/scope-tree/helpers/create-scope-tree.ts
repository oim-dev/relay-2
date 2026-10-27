import { isEmptyArray } from "shared/value-predicates";
import type { ScopeTreeFeature } from "../types/scope-tree-props.type";
import type { ScopeTreeData } from "../types/scope-tree-data.type";

/**
 * Фильтрует выбор без изменения скрытых пунктов и сохраняет родительский контекст.
 */
export const createScopeTree = (
  items: ScopeTreeFeature[],
  query: string,
  isSelectedOnly: boolean,
): ScopeTreeData => {
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const result: ScopeTreeData = { nodes: [], entries: new Map() };
  for (const feature of items) {
    if (isSelectedOnly && !feature.isEnabled) continue;
    const matchesFeature = feature.name.toLocaleLowerCase("ru").includes(normalizedQuery);
    const scenarios = feature.scenarios.filter(
      (scenario) =>
        (!isSelectedOnly || scenario.isEnabled) &&
        (matchesFeature || scenario.name.toLocaleLowerCase("ru").includes(normalizedQuery)),
    );
    if (!matchesFeature && isEmptyArray(scenarios)) continue;
    result.entries.set(feature.id, { feature });
    const children = scenarios.map((scenario) => {
      const value = `${feature.id}/${scenario.id}`;
      result.entries.set(value, { feature, scenario });
      return { value, label: scenario.name };
    });
    result.nodes.push({ value: feature.id, label: feature.name, children });
  }
  return result;
};
