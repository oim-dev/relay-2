/** Технический конверт версионированной страницы. */
type ApiPage = {
  /** Записи страницы. */
  items: unknown[];
  /** Полное количество. */
  total: number;
  /** Продолжение. */
  nextOffset: number | null;
  /** Версия первой страницы. */
  version: string;
};

/**
 * Читает только запрошенный человеком объём одним согласованным снимком.
 */
export const readApiPages = async <Page extends ApiPage>(
  count: number,
  load: (offset: number, limit: number, version?: string) => Promise<Page>,
): Promise<Page> => {
  const limit = Math.min(12, Math.max(1, count));
  const firstPage = await load(0, limit);
  const items = [...firstPage.items];
  let nextOffset = firstPage.nextOffset;
  while (items.length < count && nextOffset !== null) {
    const nextPage = await load(nextOffset, limit, firstPage.version);
    if (nextPage.version !== firstPage.version) throw new Error("Сервер смешал версии страниц");
    if (nextPage.nextOffset !== null && nextPage.nextOffset <= nextOffset)
      throw new Error("Сервер вернул не продвигающееся продолжение страницы");
    items.push(...nextPage.items);
    nextOffset = nextPage.nextOffset;
  }
  return {
    ...firstPage,
    items: items.slice(0, count),
    nextOffset:
      Math.min(count, firstPage.total) < firstPage.total ? Math.min(count, firstPage.total) : null,
  };
};
