import { createMetricUnsupportedError } from "../errors/overview-metric.error";
import type { OverviewMetricPage, OverviewMetricRequest } from "../types/product-overview.type";

/**
 * Текущий HTTP-каталог не объявляет прежние составные метрики оператора.
 * Их контролы не создаются при operator:null в модели обзора.
 */
export async function getOverviewMetricsSupport(_projectId: string): Promise<boolean> {
  return false;
}

/**
 * Защищает оставшийся визуальный компонент от ложной успешной пустой страницы.
 */
export async function getOverviewMetricPage(
  _projectId: string,
  _request: OverviewMetricRequest,
  _version: string,
  _cursor: string | null,
): Promise<OverviewMetricPage> {
  throw createMetricUnsupportedError();
}
