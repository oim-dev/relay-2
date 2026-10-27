import { useLocation } from "react-router-dom";
import { useProductPath } from "compositions/widgets/product-page";
import { ProductTreeRow } from "compositions/widgets/product-tree-row";
import { PRODUCT_STATUS_LABELS } from "domains/product";
import { isEmptyArray } from "shared/value-predicates";
import type { ApplicationFeatureProps } from "./types/application-feature-props.type";

/**
 * Открывает страницу реализации по названию, сохраняя отдельный переход к общему контракту.
 *
 * Используется для:
 *  - компактного отображения статуса и заголовка вклада под фичей или сценарием
 */
export const ApplicationFeature = (props: ApplicationFeatureProps) => {
  const { feature, contribution, scenario, isLastScenario, payload } = props;
  const base = useProductPath();
  const location = useLocation();
  const isFeature = scenario === undefined;
  const name = scenario?.name ?? feature.name;
  const selected = scenario ?? contribution;
  const anchor =
    scenario === undefined
      ? `application-feature-${feature.id}`
      : `application-feature-${feature.id}-${scenario.scenarioId}`;
  const returnTo = `${location.pathname}${location.search}#${anchor}`;
  const applicationPath = location.pathname.replace(/\/+$/, "");
  const href = `${applicationPath}/implementations/${selected.key ?? selected.contractId}`;
  const featurePath = `${base}/features/${feature.key ?? feature.id}`;
  const sourceScenario = feature.scenarios.find((entry) => entry.id === scenario?.scenarioId);
  const sourceHref =
    scenario === undefined
      ? featurePath
      : `${featurePath}/scenarios/${sourceScenario?.key ?? scenario.scenarioId}`;
  const sourceLabel = `Открыть исходное описание: ${name}`;
  const readyCount = contribution.scenarios.filter((entry) => entry.status === "done").length;
  const countLabel = isFeature
    ? isEmptyArray(contribution.scenarios)
      ? "Сценарии не выбраны"
      : `Сценарии: ${readyCount} из ${contribution.scenarios.length} реализовано`
    : undefined;
  return (
    <div>
      <ProductTreeRow
        id={anchor}
        tabIndex={-1}
        name={name}
        entityKey={selected.key}
        summary={selected.title}
        status={selected.status}
        readinessLabel={PRODUCT_STATUS_LABELS[selected.status]}
        href={href}
        sourceHref={sourceHref}
        sourceLabel={sourceLabel}
        returnTo={returnTo}
        countLabel={countLabel}
        isFeature={isFeature}
        isLastScenario={isLastScenario}
        payload={payload}
      />
    </div>
  );
};
