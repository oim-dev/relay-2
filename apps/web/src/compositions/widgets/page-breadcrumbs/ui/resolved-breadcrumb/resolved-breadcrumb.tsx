import { useEntitySummary } from "domains/entities";
import { useBoard } from "domains/boards";
import { BreadcrumbLink } from "../breadcrumb-link/breadcrumb-link";
import type { ResolvedBreadcrumbProps } from "./types/resolved-breadcrumb-props.type";

/**
 * Подставляет актуальное название записи, сохраняя навигацию при недоступности данных.
 *
 * Используется для:
 *  - адресного чтения названий без загрузки каталогов
 *  - обновления пути после изменения записи через SSE
 */
export const ResolvedBreadcrumb = (props: ResolvedBreadcrumbProps) => {
  const { source, item, ...linkProps } = props;
  const isBoard = source.kind === "board";
  const reference = isBoard ? null : `${source.kind}:${source.reference}`;
  const boardSlug = isBoard ? source.reference : "";
  const entityQuery = useEntitySummary(source.projectId, reference);
  const boardQuery = useBoard(source.projectId, boardSlug);
  const entityData = entityQuery.data;
  const title = isBoard ? boardQuery.data?.name : entityData?.title;
  const titleLabel = title?.trim() || item.label;
  const label =
    source.kind === "task" && entityData ? `${entityData.key} · ${titleLabel}` : titleLabel;
  const resolvedItem = { ...item, label };
  return <BreadcrumbLink {...linkProps} item={resolvedItem} />;
};
