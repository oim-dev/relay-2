import type { ContextExplorerProps } from "../ui/context-explorer/types/context-explorer-props.type";

/**
 * Открывает дерево по умолчанию, сохраняя совместимость прежних ссылок на диаграмму.
 */
export const readContextMode = (params: URLSearchParams): ContextExplorerProps["mode"] => {
  const mode = params.get("mode");
  if (mode === "list") return "list";
  if (mode === "graph" || mode === "diagram") return "graph";
  return "tree";
};
