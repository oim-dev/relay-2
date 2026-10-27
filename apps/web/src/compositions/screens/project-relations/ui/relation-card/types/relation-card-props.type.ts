import type { RelationEdge, RelationNode } from "domains/relations";
/** Представление одного отношения и его действий. */
export type RelationCardProps = {
  /** Отношение. */
  edge: RelationEdge;
  /** Подпись начальной сущности. */
  fromLabel: string;
  /** Подпись конечной сущности. */
  toLabel: string;
  /** Сосед для компактного чтения прямого отношения. */
  neighbor?: RelationNode;
  /** Выбирает корень контекста. */
  onSelect: (address: string) => void;
  /** Отзывает редактируемую связь. */
  onRemove: (id: string) => Promise<void>;
};
