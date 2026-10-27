import type { OverviewPreview } from "../types/product-overview.type";

/**
 * Переносит total страницы без вывода полноты из длины её ограниченной подборки.
 */
export function preview<T>(page: { readonly total: number }, items: T[]): OverviewPreview<T> {
  return { items, total: page.total, hasMore: page.total > items.length };
}
