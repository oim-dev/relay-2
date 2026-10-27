import type { RelationNode, RelationEdge } from "domains/relations";

/** Последовательное представление того же загруженного графа. */
export type ContextListProps = {
  /** Загруженные карточки. */
  nodes: RelationNode[];
  /** Загруженные отношения. */
  edges: RelationEdge[];
  /** Выбранный постоянный адрес. */
  selectedNodeId: string | null;
  /** Выбранная связь. */
  selectedEdgeId: string | null;
  /** Показывает подробности узла. */
  onNodeSelect: (address: string) => void;
  /** Показывает подробности отношения. */
  onEdgeSelect: (id: string) => void;
};
