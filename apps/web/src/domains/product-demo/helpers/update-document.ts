import type { ProductDocumentInput, ProductSnapshot } from "../types/product-demo.type";

/**
 * Обновляет документ, сохраняя состав и описания вкладов приложений.
 */
export const updateDocument = (
  snapshot: ProductSnapshot,
  input: ProductDocumentInput,
): ProductSnapshot => {
  const documentData = {
    id: input.id,
    name: input.name.trim(),
    summary: input.summary.trim(),
    description: input.description,
  };
  const nextSnapshot = { ...snapshot, revision: snapshot.revision + 1 };
  if (input.kind === "passport") return { ...nextSnapshot, passport: documentData };
  if (input.kind === "scenarios") {
    const scenarioData = {
      id: input.id,
      name: input.name.trim(),
      description: input.description,
      status: input.status,
    };
    const features = snapshot.features.map((feature) => {
      if (feature.id !== input.featureId) return feature;
      const hasScenario = feature.scenarios.some((scenario) => scenario.id === input.id);
      const scenarios = hasScenario
        ? feature.scenarios.map((scenario) => (scenario.id === input.id ? scenarioData : scenario))
        : [...feature.scenarios, scenarioData];
      return { ...feature, scenarios };
    });
    return { ...nextSnapshot, features };
  }
  if (input.kind === "features") {
    const previousFeature = snapshot.features.find((feature) => feature.id === input.id);
    const featureData = { ...documentData, scenarios: previousFeature?.scenarios ?? [] };
    const hasFeature = snapshot.features.some((feature) => feature.id === input.id);
    const features = hasFeature
      ? snapshot.features.map((feature) => (feature.id === input.id ? featureData : feature))
      : [...snapshot.features, featureData];
    return { ...nextSnapshot, features };
  }
  const applicationData = {
    ...documentData,
    type: input.type,
    slug: input.slug,
    prefix: input.prefix,
  };
  const hasApplication = snapshot.applications.some((application) => application.id === input.id);
  const applications = hasApplication
    ? snapshot.applications.map((application) =>
        application.id === input.id ? applicationData : application,
      )
    : [...snapshot.applications, applicationData];
  return { ...nextSnapshot, applications };
};
