import { isDefined } from "shared/value-predicates";
import { BreadcrumbLink } from "../breadcrumb-link/breadcrumb-link";
import { ResolvedBreadcrumb } from "../resolved-breadcrumb/resolved-breadcrumb";
import type { BreadcrumbItemProps } from "./types/breadcrumb-item-props.type";

/**
 * Выбирает статическую или адресно загружаемую подпись уровня.
 *
 * Используется для:
 *  - отображения одного пункта строки и меню родителей
 */
export const BreadcrumbItem = (props: BreadcrumbItemProps) => {
  const source = props.item.source;
  if (isDefined(source)) return <ResolvedBreadcrumb {...props} source={source} />;
  return <BreadcrumbLink {...props} />;
};
