import { generatePath } from "react-router-dom";
import type { UIMatch, Location } from "react-router-dom";
import { z } from "zod";
import { isDefined } from "shared/value-predicates";
import { BREADCRUMB_HANDLE_SCHEMA } from "../config/route-breadcrumb.schema";
import type { PageBreadcrumb } from "../types/page-breadcrumbs-props.type";

/** Только локальные адреса возврата, созданные продуктовыми экранами. */
const RETURN_STATE_SCHEMA = z.object({
  returnTo: z.string().optional(),
  editorReturnTo: z.string().optional(),
});

/**
 * Сохраняет контекст конкретного родителя, не перенося чужие фильтры между разделами.
 */
const getParentHref = (href: string, location: Location, preserveBoardFilters: boolean): string => {
  if (preserveBoardFilters) {
    const currentSearch = new URLSearchParams(location.search);
    const parentSearch = new URLSearchParams();
    for (const key of ["q", "blocked", "cancelled"]) {
      const value = currentSearch.get(key);
      if (isDefined(value)) parentSearch.set(key, value);
    }
    const search = parentSearch.toString();
    return search === "" ? href : `${href}?${search}`;
  }
  const state = RETURN_STATE_SCHEMA.safeParse(location.state);
  if (!state.success) return href;
  const candidates = [state.data.editorReturnTo, state.data.returnTo];
  return candidates.find((address) => address?.split(/[?#]/)[0] === href) ?? href;
};

/**
 * Строит путь из совпавших маршрутов; технические сегменты не становятся уровнями сами собой.
 */
export const buildProjectBreadcrumbs = (
  matches: UIMatch[],
  base: string,
  projectId: string,
  projectName: string,
  location: Location,
): PageBreadcrumb[] => {
  const items: PageBreadcrumb[] = [{ id: "project", label: projectName, href: base }];
  for (const match of matches) {
    const handle = BREADCRUMB_HANDLE_SCHEMA.safeParse(match.handle);
    if (!handle.success) continue;
    const encodedParams = Object.fromEntries(
      Object.entries(match.params).map(([key, value]) => [
        key,
        isDefined(value) ? encodeURIComponent(value) : null,
      ]),
    );
    handle.data.breadcrumbs.forEach((breadcrumb, index) => {
      const href = isDefined(breadcrumb.path)
        ? `${base}${generatePath(breadcrumb.path, encodedParams)}`
        : undefined;
      const reference = isDefined(breadcrumb.source)
        ? match.params[breadcrumb.source.param]
        : undefined;
      const source =
        isDefined(reference) && isDefined(breadcrumb.source)
          ? { projectId, kind: breadcrumb.source.kind, reference }
          : undefined;
      const label = isDefined(reference) ? `${breadcrumb.label} ${reference}` : breadcrumb.label;
      items.push({
        id: `${match.id}:${index}`,
        label,
        href: isDefined(href)
          ? getParentHref(href, location, breadcrumb.preserveBoardFilters === true)
          : undefined,
        source,
      });
    });
  }
  return items;
};
