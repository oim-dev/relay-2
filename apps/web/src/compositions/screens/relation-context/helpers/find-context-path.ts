import { getRelationPaths, relationAddress } from "domains/relations";
import type { RelationDiagram, RelationDiagramFilter, RelationPath } from "domains/relations";

/**
 * Объясняет включение тем же кратчайшим путём, который используется в дереве.
 */
export const findContextPath = (
  graph: RelationDiagram,
  target: string,
  direction: RelationDiagramFilter["direction"],
): RelationPath | null => {
  return (
    getRelationPaths(graph.nodes, graph.edges, relationAddress(graph.root.ref), direction).get(
      target,
    ) ?? null
  );
};
