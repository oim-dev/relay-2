import type { ScopeFormValues } from "../types/scope-form-values.type";

/**
 * Требует описание только у включённых элементов и возвращает точные пути полей.
 */
export const validateScopeValues = (values: ScopeFormValues): Record<string, string> => {
  const errors: Record<string, string> = {};
  values.features.forEach((feature, featureIndex) => {
    if (!feature.isEnabled) return;
    if (feature.title.trim() === "")
      errors[`features.${featureIndex}.title`] = "Добавьте заголовок вклада";
    if (feature.description.trim() === "")
      errors[`features.${featureIndex}.description`] = "Опишите вклад приложения в фичу";
    feature.scenarios.forEach((scenario, scenarioIndex) => {
      if (scenario.isEnabled && scenario.title.trim() === "")
        errors[`features.${featureIndex}.scenarios.${scenarioIndex}.title`] =
          "Добавьте заголовок вклада";
      if (scenario.isEnabled && scenario.description.trim() === "")
        errors[`features.${featureIndex}.scenarios.${scenarioIndex}.description`] =
          "Опишите вклад приложения в сценарий";
    });
  });
  return errors;
};
