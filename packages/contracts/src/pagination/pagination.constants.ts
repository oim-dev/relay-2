/**
 * Допустимый размер страницы для SQL-списков и вычисленных составов Core.
 */
export const ENTITY_PAGE_SIZE = { min: 1, max: 100 } as const;

/**
 * Поддерживаемые основные ключи сортировки; равенство разрешается постоянным ID.
 */
export const ENTITY_PAGE_SORTS = ["key", "title", "updated"] as const;
