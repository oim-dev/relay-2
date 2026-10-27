/** ID имеет приоритет; неоднозначный ключ не выбирает случайную запись. */
export const findProductEntry = <T extends { id: string; key?: string }>(
  items: T[],
  ref: string | undefined,
): T | undefined => {
  const byId = items.find((entry) => entry.id === ref);
  if (byId !== undefined) return byId;
  const matches = items.filter((entry) => entry.key !== undefined && entry.key === ref);
  return matches.length === 1 ? matches[0] : undefined;
};

/** Относительный публичный адрес выбранной продуктовой сущности. */
export const productEntityPath = (entity: {
  id: string;
  key?: string;
  kind: string;
  featureId?: string | null;
  featureKey?: string | null;
  targetKey?: string | null;
  applicationId?: string | null;
  applicationKey?: string | null;
}): string => {
  const parent = entity.featureId;
  if (entity.kind === "scenario" && parent !== undefined && parent !== null)
    return `/features/${encodeURIComponent(parent)}/scenarios/${encodeURIComponent(entity.id)}`;
  const application = entity.applicationId;
  if (entity.kind === "implementation" && application !== undefined && application !== null)
    return `/applications/${encodeURIComponent(application)}/implementations/${encodeURIComponent(entity.id)}`;
  const collection = {
    feature: "features",
    scenario: "scenarios",
    application: "applications",
    implementation: "implementations",
    document: "documents",
    passport: "passport",
  }[entity.kind];
  return collection === "passport"
    ? "/passport"
    : `/${collection}/${encodeURIComponent(entity.id)}`;
};
