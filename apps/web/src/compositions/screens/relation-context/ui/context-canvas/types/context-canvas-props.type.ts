import type { ComponentPropsWithoutRef } from "react";
import type { RelationNode, RelationEdge, RelationDiagramFilter } from "domains/relations";

/** Вход согласованной проекции графа, без операций записи. */
export type ContextCanvasParams = {
  /** Все прочитанные карточки. */
  nodes: RelationNode[];
  /** Все прочитанные связи. */
  edges: RelationEdge[];
  /** Постоянный адрес исходной сущности. */
  root: string;
  /** Дерево основных путей либо все сохранённые связи загруженной области. */
  view: "tree" | "graph";
  /** Направление поиска путей от исходной сущности. */
  direction: RelationDiagramFilter["direction"];
  /** Выбранная карточка. */
  selectedNodeId: string | null;
  /** Выбранное отношение. */
  selectedEdgeId: string | null;
  /** Подсвеченный объясняющий путь по ID связей. */
  pathEdgeIds: string[];
  /** Адреса граничных узлов. */
  boundaryIds: string[];
  /** Открывает сведения узла. */
  onNodeSelect: (address: string) => void;
  /** Открывает сведения связи. */
  onEdgeSelect: (id: string) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства самостоятельной области визуализации и камеры. */
export type ContextCanvasProps = RootAttrs & ContextCanvasParams;
