import type { HistorySessionStatus } from "@relay/contracts";

/**
 * Проверенные фильтры каталога сессий; страницы и их поколение принадлежат useEntityPages.
 */
export interface HistorySessionListProps {
  /* Поисковый ввод из URL; пустая строка не передаёт фильтр Core. */
  readonly query: string;
  /* Текущий статус сессии; undefined означает отсутствие отбора по статусу. */
  readonly status: HistorySessionStatus | undefined;
}
