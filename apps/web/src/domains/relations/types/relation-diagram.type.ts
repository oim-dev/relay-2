import type { RelationNode, RelationEdge, RelationsPage } from "./relations.type";

/** Условия направленного исследования сохранённых связей. */
export type RelationDiagramFilter = {
  /** Направление каждого шага обхода. */
  direction: "both" | "incoming" | "outgoing";
  /** Тип связи; отсутствие означает все типы. */
  type?: string;
};

/** Раскрытая область и запрошенное продолжение. */
export type RelationDiagramRegion = {
  /** Постоянный адрес исходной сущности области. */
  root: string;
  /** Глубина обхода этой области. */
  depth: number;
  /** Число последовательно читаемых страниц. */
  pages: number;
};

/** Согласованное чтение областей одного графа. */
export type RelationDiagramRequest = RelationDiagramFilter & {
  /** Исходный постоянный адрес всего просмотра. */
  root: string;
  /** Основная область и явно раскрытые соседи. */
  regions: RelationDiagramRegion[];
  /** Версия при продолжении; отсутствие начинает новый снимок. */
  version?: string;
};

/** Граница чтения одной области. */
export type RelationDiagramBoundary = RelationDiagramRegion & {
  /** Непрочитанная страница; null означает конец области заданной глубины. */
  nextOffset: number | null;
  /** Общее число узлов в области. */
  totalNodes: number;
  /** Общее число рёбер в области. */
  totalEdges: number;
  /** Есть связи за выбранной глубиной. */
  isDepthLimited: boolean;
};

/** Снимок ограниченной визуальной выборки, не полный entity_context. */
export type RelationDiagram = {
  /** Корень всегда включён, даже если он не попал в страницу узлов. */
  root: RelationNode;
  /** Единственная версия всех частей снимка. */
  version: string;
  /** Объединённые карточки и концы рёбер без дубликатов. */
  nodes: RelationNode[];
  /** Все прочитанные отношения, включая петли и параллельные рёбра. */
  edges: RelationEdge[];
  /** Объясняющие пути основного обхода, а не замена рёбер. */
  paths: RelationsPage["paths"];
  /** Доступное продолжение каждой области. */
  regions: RelationDiagramBoundary[];
  /** Адреса узлов на границе глубины. */
  boundary: string[];
};
