import type { PageBreadcrumbsProps } from "../../../types/page-breadcrumbs-props.type";

/** Оформление проектной проекции; данные принадлежат текущему маршруту. */
export type ProjectBreadcrumbsProps = Omit<PageBreadcrumbsProps, "items">;
