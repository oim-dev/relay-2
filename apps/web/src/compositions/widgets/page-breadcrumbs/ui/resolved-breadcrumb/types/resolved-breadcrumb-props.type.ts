import type { BreadcrumbSource } from "../../../types/page-breadcrumbs-props.type";
import type { BreadcrumbItemProps } from "../../breadcrumb-item/types/breadcrumb-item-props.type";

/** Свойства уровня, название которого читается адресно. */
export type ResolvedBreadcrumbProps = BreadcrumbItemProps & {
  /** Подтверждённый источник данных. */
  source: BreadcrumbSource;
};
