import { RelayError } from "./index";

/** Окно согласованного списка (limit 1..100); сортировка по ID разрешает равные основные ключи. */
export interface EntityPageRequest {
  offset: number;
  limit: number;
  sort: "key" | "title" | "updated";
}

export interface EntityPage<T> {
  items: T[];
  total: number;
}

/** Единые границы окна для SQL-списков и вычисленных в Core составов. */
export function validateEntityPageRequest(value: EntityPageRequest): void {
  if (
    !value ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100 ||
    !["key", "title", "updated"].includes(value.sort)
  ) {
    throw new RelayError("INVALID_ARGUMENT", "Некорректное окно списка.", 2);
  }
}
