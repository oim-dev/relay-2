import type { ENTITY_PAGE_SORTS } from "./pagination.constants";

/**
 * Основной ключ сортировки страницы из общего перечня ENTITY_PAGE_SORTS.
 */
type EntityPageSort = (typeof ENTITY_PAGE_SORTS)[number];

/**
 * Окно согласованного списка без значений по умолчанию.
 * Размер ограничен ENTITY_PAGE_SIZE; offset и limit — безопасные целые числа.
 * Сортировка по постоянному ID разрешает равенство основных ключей.
 */
export interface EntityPageRequest {
  /* Число пропускаемых записей от начала упорядоченного списка, не меньше нуля. */
  readonly offset: number;
  /* Максимальное число возвращаемых записей в пределах ENTITY_PAGE_SIZE. */
  readonly limit: number;
  /* Основной ключ сортировки: читаемый ключ, название либо время обновления. */
  readonly sort: EntityPageSort;
}

/**
 * Страница и полное число совпадений, полученные из одного согласованного снимка.
 */
export interface EntityPage<T> {
  /* Записи в порядке запроса; пустой массив допустим, в том числе при ненулевом total. */
  items: T[];
  /* Число всех записей после фильтрации и до применения offset и limit. */
  total: number;
}
