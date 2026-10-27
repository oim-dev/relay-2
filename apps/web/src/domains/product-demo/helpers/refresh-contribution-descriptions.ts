import { CONTRIBUTION_DETAILS, CONTRIBUTION_SEEDS } from "../config/contribution-seeds";
import { LEGACY_CONTRIBUTION_DESCRIPTIONS } from "../config/legacy-contribution-descriptions";
import type { ProductSnapshot } from "../types/product-demo.type";

/**
 * Обновляет прежние стандартные моки; пользовательский текст, выбор, заголовки и состояния сохраняются.
 */
export const refreshContributionDescriptions = (snapshot: ProductSnapshot): ProductSnapshot => {
  let hasChanges = false;
  const contributions = snapshot.contributions.map((entry) => {
    const seed = CONTRIBUTION_SEEDS.find(
      (item) => item.featureId === entry.featureId && item.applicationId === entry.applicationId,
    );
    const previous = CONTRIBUTION_DETAILS.find(
      (item) => item.featureId === entry.featureId && item.applicationId === entry.applicationId,
    );
    if (seed === undefined || previous === undefined) return entry;
    const isStandardDescription =
      entry.description === previous.description ||
      entry.description ===
        LEGACY_CONTRIBUTION_DESCRIPTIONS[`${entry.applicationId}/${entry.featureId}`];
    const description = isStandardDescription ? seed.description : entry.description;
    const scenarios = entry.scenarios.map((scenario) => {
      const oldScenario = previous.scenarios.find(
        (item) => item.scenarioId === scenario.scenarioId,
      );
      const newScenario = seed.scenarios.find((item) => item.scenarioId === scenario.scenarioId);
      if (
        oldScenario === undefined ||
        newScenario === undefined ||
        scenario.description !== oldScenario.description
      )
        return scenario;
      hasChanges = true;
      return { ...scenario, description: newScenario.description };
    });
    if (description !== entry.description) hasChanges = true;
    return { ...entry, description, scenarios };
  });
  if (!hasChanges) return snapshot;
  return { ...snapshot, revision: snapshot.revision + 1, contributions };
};
