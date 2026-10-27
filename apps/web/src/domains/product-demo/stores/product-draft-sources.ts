import type { ProductState } from "domains/product";

const sources = new Map<string, Map<string, ProductState>>();

/**
 * Основания открывавшихся редакторов живут в памяти вкладки, отдельно от SWR.
 * Возврат A → B → A сохраняет исходные guards; origin и проект изолируют записи.
 * После reload неизвестный старый draft не получает свежую ревизию автоматически.
 */
export function productDraftSources(project: string): Map<string, ProductState> {
  const key = JSON.stringify([typeof location === "undefined" ? "" : location.origin, project]);
  let scope = sources.get(key);
  if (!scope) {
    scope = new Map();
    sources.set(key, scope);
  }
  return scope;
}
