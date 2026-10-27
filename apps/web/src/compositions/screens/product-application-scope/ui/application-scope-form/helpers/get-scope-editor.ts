import type { ProductFeature } from "domains/product-demo";
import type { ScopeFormValues, ScopeTarget } from "../types/scope-form-values.type";

/**
 * Находит исходный контракт и путь редактируемого поля без копирования значений формы.
 */
export const getScopeEditor = (
  features: ProductFeature[],
  values: ScopeFormValues,
  target?: ScopeTarget,
) => {
  const featureIndex = values.features.findIndex((entry) => entry.featureId === target?.featureId);
  const selected = values.features[featureIndex];
  const feature = features.find((entry) => entry.id === target?.featureId);
  if (feature === undefined || selected === undefined) return undefined;
  if (target?.scenarioId === undefined)
    return {
      title: feature.name,
      context: "Фича",
      source: feature.description,
      isEnabled: selected.isEnabled,
      path: `features.${featureIndex}.description`,
      titlePath: `features.${featureIndex}.title`,
      statusPath: `features.${featureIndex}.status`,
      status: selected.status,
      featureId: feature.id,
      scenarioId: undefined,
    };
  const scenarioIndex = selected.scenarios.findIndex(
    (entry) => entry.scenarioId === target.scenarioId,
  );
  const scenario = feature.scenarios.find((entry) => entry.id === target.scenarioId);
  const scenarioValue = selected.scenarios[scenarioIndex];
  if (scenario === undefined || scenarioValue === undefined) return undefined;
  return {
    title: scenario.name,
    context: `Сценарий · ${feature.name}`,
    source: scenario.description,
    isEnabled: selected.isEnabled && scenarioValue.isEnabled,
    path: `features.${featureIndex}.scenarios.${scenarioIndex}.description`,
    titlePath: `features.${featureIndex}.scenarios.${scenarioIndex}.title`,
    statusPath: `features.${featureIndex}.scenarios.${scenarioIndex}.status`,
    status: scenarioValue.status,
    featureId: feature.id,
    scenarioId: scenario.id,
  };
};
