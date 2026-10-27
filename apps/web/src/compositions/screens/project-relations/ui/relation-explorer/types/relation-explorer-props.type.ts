import type { RelationsPage } from "domains/relations";

/** Согласованная страница окружения выбранной сущности. */
export type RelationExplorerProps = {
  /** Ответ графа с карточками концов связей. */
  graph: RelationsPage;
  /** Канонический адрес корня. */
  root: string;
  /** Сразу раскрывает продолжение цепочки. */
  isChain: boolean;
  /** Смещение текущей страницы. */
  offset: number;
  /** Открывает окружение соседа. */
  onSelect: (address: string) => void;
  /** Отзывает явную связь. */
  onRemove: (id: string) => Promise<void>;
  /** Открывает другую страницу одного снимка. */
  onPage: (offset: number) => void;
};
