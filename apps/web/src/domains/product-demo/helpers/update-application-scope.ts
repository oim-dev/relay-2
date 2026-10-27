import type { ProductContributionInput, ProductSnapshot } from "../types/product-demo.type";

/**
 * Заменяет участие одного приложения, сохраняя общие сценарии и вклады остальных приложений.
 */
export const updateApplicationScope = (
  snapshot: ProductSnapshot,
  applicationId: string,
  contributions: ProductContributionInput[],
): ProductSnapshot => ({
  ...snapshot,
  revision: snapshot.revision + 1,
  contributions: [
    ...snapshot.contributions.filter((entry) => entry.applicationId !== applicationId),
    ...contributions.map((entry) => ({
      applicationId,
      featureId: entry.featureId,
      title: entry.title.trim(),
      description: entry.description.trim(),
      status: entry.status,
      scenarios: entry.scenarios.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        title: scenario.title.trim(),
        description: scenario.description.trim(),
        status: scenario.status,
      })),
    })),
  ],
});
