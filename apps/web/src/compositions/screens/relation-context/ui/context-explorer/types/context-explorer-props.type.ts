import type { RelationDiagramFilter } from "domains/relations";

/** Область просмотра, задаваемая URL экрана. */
export type ContextExplorerProps = {
  /** Изолированный проект чтения. */
  projectId: string;
  /** Ключ либо постоянный адрес корня. */
  root: string;
  /** Проверенные условия основной области. */
  options: RelationDiagramFilter & {
    /** Начальная глубина обхода. */
    depth: number;
  };
  /** Дерево основных путей, все линии графа или последовательный список. */
  mode: "tree" | "graph" | "list";
  /** Меняет корень в URL и истории браузера. */
  onRoot: (address: string) => void;
  /** Дополняет фильтр расширенными типами загруженных связей. */
  onTypes: (types: string[]) => void;
};
