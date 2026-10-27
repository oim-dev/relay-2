import { getFeatureStatus } from "domains/product-demo";
import { useProductPath } from "compositions/widgets/product-page";
import { ProductTreeRow } from "compositions/widgets/product-tree-row";
import { isEmptyArray } from "shared/value-predicates";
import type { FeatureRowProps } from "./types/feature-row-props.type";

/**
 * Отображает узел фичи или сценария с отдельными действиями раскрытия и перехода.
 *
 * Используется для:
 *  - чтения двухуровневого дерева и перехода к нужному описанию
 */
export const FeatureRow = (props: FeatureRowProps) => {
  const { feature, scenario, isLastScenario = false, payload, search } = props;
  const base = useProductPath();
  const isFeature = scenario === undefined;
  const name = scenario?.name ?? feature.name;
  const status = scenario?.status ?? getFeatureStatus(feature);
  const hasNoScenarios = isEmptyArray(feature.scenarios);
  const countLabel = isFeature
    ? hasNoScenarios
      ? "Сценарии не описаны"
      : `Сценариев: ${feature.scenarios.length}`
    : undefined;
  const summary = isFeature ? feature.summary : undefined;
  const href = `${base}/features/${feature.key ?? feature.id}${search}`;
  const target =
    scenario === undefined
      ? href
      : `${base}/features/${feature.key ?? feature.id}/scenarios/${scenario.key ?? scenario.id}${search}`;
  const entityKey = scenario?.key ?? feature.key;
  return (
    <ProductTreeRow
      name={name}
      entityKey={entityKey}
      summary={summary}
      href={target}
      returnTo={`${base}/features${search}`}
      status={status ?? "none"}
      readinessLabel={status === undefined ? "Готовность не предоставляется" : undefined}
      countLabel={countLabel}
      isFeature={isFeature}
      isLastScenario={isLastScenario}
      payload={payload}
    />
  );
};
