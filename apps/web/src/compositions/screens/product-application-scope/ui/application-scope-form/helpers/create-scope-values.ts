import type { ProductContribution, ProductFeature } from "domains/product-demo";
import type { ScopeFormValues } from "../types/scope-form-values.type";

/**
 * Совмещает актуальный каталог с подтверждённым составом и сохранённым вводом по постоянным ID.
 */
export const createScopeValues = (
  features: ProductFeature[],
  contributions: ProductContribution[],
  draft?: ScopeFormValues,
): ScopeFormValues => ({
  features: features.map((feature) => {
    const contribution = contributions.find((entry) => entry.featureId === feature.id);
    const saved = draft?.features.find((entry) => entry.featureId === feature.id);
    return {
      featureId: feature.id,
      isEnabled: saved?.isEnabled ?? contribution !== undefined,
      title: saved?.title ?? contribution?.title ?? "",
      description: saved?.description ?? contribution?.description ?? "",
      status: saved?.status ?? contribution?.status ?? "none",
      scenarios: feature.scenarios.map((scenario) => {
        const selected = contribution?.scenarios.find((entry) => entry.scenarioId === scenario.id);
        const stored = saved?.scenarios.find((entry) => entry.scenarioId === scenario.id);
        return {
          scenarioId: scenario.id,
          isEnabled: stored?.isEnabled ?? selected !== undefined,
          title: stored?.title ?? selected?.title ?? "",
          description: stored?.description ?? selected?.description ?? "",
          status: stored?.status ?? selected?.status ?? "none",
        };
      }),
    };
  }),
});
