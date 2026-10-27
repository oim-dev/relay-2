import type { ProductContributionInput, ProductSnapshot } from "../types/product-demo.type";

/**
 * Проверяет принадлежность сценариев, уникальность выбора и наличие описаний вкладов.
 */
export const validateApplicationScope = (
  snapshot: ProductSnapshot,
  applicationId: string,
  contributions: ProductContributionInput[],
): string => {
  if (!snapshot.applications.some((application) => application.id === applicationId))
    return "Приложение больше не существует. Ваш ввод сохранён.";
  const featureIds = new Set<string>();
  for (const contribution of contributions) {
    const feature = snapshot.features.find((entry) => entry.id === contribution.featureId);
    if (feature === undefined)
      return "Одна из выбранных фич больше не существует. Обновите состав.";
    if (featureIds.has(feature.id))
      return "Фича выбрана несколько раз. Проверьте состав приложения.";
    featureIds.add(feature.id);
    if (contribution.title.trim() === "")
      return `Добавьте заголовок вклада в фичу «${feature.name}».`;
    if (contribution.description.trim() === "") return `Опишите вклад в фичу «${feature.name}».`;
    const scenarioIds = new Set<string>();
    for (const selected of contribution.scenarios) {
      const scenario = feature.scenarios.find((entry) => entry.id === selected.scenarioId);
      if (scenario === undefined) return `Состав сценариев фичи «${feature.name}» изменился.`;
      if (scenarioIds.has(scenario.id)) return "Один сценарий выбран несколько раз.";
      scenarioIds.add(scenario.id);
      if (selected.title.trim() === "")
        return `Добавьте заголовок вклада в сценарий «${scenario.name}».`;
      if (selected.description.trim() === "") return `Опишите вклад в сценарий «${scenario.name}».`;
    }
  }
  return "";
};
