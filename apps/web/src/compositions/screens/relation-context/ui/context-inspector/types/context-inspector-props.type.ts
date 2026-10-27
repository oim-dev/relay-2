import type { RelationNode, RelationEdge } from "domains/relations";

/** Сведения выбранного элемента и действия исследования. */
export type ContextInspectorProps = {
  /** Проект чтения полного текста. */
  projectId: string;
  /** Выбранная карточка либо отсутствие выбора. */
  node?: RelationNode;
  /** Выбранная связь вместо карточки. */
  edge?: RelationEdge;
  /** Карточки концов отношения. */
  nodes: RelationNode[];
  /** Все загруженные связи, включая дополнительные к дереву. */
  edges: RelationEdge[];
  /** Выбранный узел совпадает с исходным. */
  isRoot: boolean;
  /** Можно добавить ещё одну область. */
  canExpand: boolean;
  /** Объясняющий путь уже загружен. */
  hasPath: boolean;
  /** Запрос или ошибка временно запрещает расширение. */
  isBusy: boolean;
  /** Добавляет окружение выбранной карточки. */
  onExpand: () => void;
  /** Меняет исходную сущность. */
  onRoot: (address: string) => void;
  /** Выделяет один путь включения. */
  onPath: () => void;
  /** Выбирает конец отношения без смены исходного узла. */
  onNodeSelect: (address: string) => void;
  /** Открывает подробности отношения из списка выбранной сущности. */
  onEdgeSelect: (id: string) => void;
};
