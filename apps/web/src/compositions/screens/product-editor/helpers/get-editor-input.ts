import type {
  ProductDocumentInput,
  ProductDocumentKind,
  ProductSnapshot,
} from "domains/product-demo";

/**
 * Готовит метаданные документа независимо от состава реализации приложений.
 */
export const getEditorInput = (
  snapshot: ProductSnapshot,
  kind: ProductDocumentKind,
  id: string,
  featureId = "",
): ProductDocumentInput | undefined => {
  const featureData = snapshot.features.find((feature) => feature.id === featureId);
  const scenarioData = featureData?.scenarios.find((scenario) => scenario.id === id);
  const applicationData = snapshot.applications.find((application) => application.id === id);
  const documentData =
    kind === "passport"
      ? snapshot.passport
      : kind === "scenarios"
        ? scenarioData
        : snapshot[kind].find((document) => document.id === id);
  if (kind === "scenarios" && featureData === undefined) return undefined;
  if (id !== "" && documentData === undefined) return undefined;
  return {
    kind,
    id: documentData?.id ?? "",
    featureId,
    name: documentData?.name ?? "",
    summary: documentData !== undefined && "summary" in documentData ? documentData.summary : "",
    description: documentData?.description ?? "",
    status: scenarioData?.status ?? "none",
    type: applicationData?.type ?? "Фронтенд",
    slug: applicationData?.slug ?? "",
    prefix: applicationData?.prefix ?? "",
  };
};
