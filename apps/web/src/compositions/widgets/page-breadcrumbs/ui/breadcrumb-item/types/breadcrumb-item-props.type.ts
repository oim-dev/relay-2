import type { PageBreadcrumb } from "../../../types/page-breadcrumbs-props.type";

/** Параметры пункта в строке или меню пути. */
export type BreadcrumbItemProps = {
  /** Уровень навигации. */
  item: PageBreadcrumb;
  /** Признак текущей страницы. */
  isCurrent?: boolean;
  /** Отображение в меню сокращённых уровней. */
  inMenu?: boolean;
  /** Класс, переданный Mantine Breadcrumbs. */
  className?: string;
};
