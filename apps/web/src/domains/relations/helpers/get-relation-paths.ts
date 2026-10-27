import { relationAddress } from "./relation-address";
import type { RelationNode, RelationEdge } from "../types/relations.type";
import type { RelationDiagramFilter } from "../types/relation-diagram.type";
import type { RelationPath } from "../types/relation-path.type";

/** Один допустимый шаг направленного обхода. */
type RelationStep = {
  /** Адрес следующей сущности. */
  nodeId: string;
  /** ID сохранённой связи. */
  edgeId: string;
};

/**
 * Находит по одному устойчивому кратчайшему пути по прочитанным рёбрам.
 * Порядок страниц не влияет на выбор пути; входящее чтение не разворачивает запись ребра.
 */
export const getRelationPaths = (
  nodes: RelationNode[],
  edges: RelationEdge[],
  root: string,
  direction: RelationDiagramFilter["direction"],
): Map<string, RelationPath> => {
  const nodesById = new Map(nodes.map((node) => [relationAddress(node.ref), node]));
  const pathsById = new Map<string, RelationPath>();
  if (!nodesById.has(root)) {
    return pathsById;
  }
  const neighborsById = new Map<string, RelationStep[]>();
  for (const edge of edges) {
    const from = relationAddress(edge.from);
    const to = relationAddress(edge.to);
    if (!nodesById.has(from) || !nodesById.has(to)) {
      continue;
    }
    if (direction !== "incoming") {
      neighborsById.set(from, [
        ...(neighborsById.get(from) ?? []),
        { nodeId: to, edgeId: edge.id },
      ]);
    }
    if (direction !== "outgoing") {
      neighborsById.set(to, [...(neighborsById.get(to) ?? []), { nodeId: from, edgeId: edge.id }]);
    }
  }
  const collator = new Intl.Collator("ru", { numeric: true });
  for (const neighbors of neighborsById.values()) {
    neighbors.sort(
      (left, right) =>
        collator.compare(
          nodesById.get(left.nodeId)?.key ?? left.nodeId,
          nodesById.get(right.nodeId)?.key ?? right.nodeId,
        ) ||
        left.nodeId.localeCompare(right.nodeId) ||
        left.edgeId.localeCompare(right.edgeId),
    );
  }
  pathsById.set(root, { nodes: [root], edges: [] });
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const address = queue[index];
    if (address === undefined) {
      continue;
    }
    const path = pathsById.get(address);
    if (!path) {
      continue;
    }
    for (const neighbor of neighborsById.get(address) ?? []) {
      if (pathsById.has(neighbor.nodeId)) {
        continue;
      }
      pathsById.set(neighbor.nodeId, {
        nodes: [...path.nodes, neighbor.nodeId],
        edges: [...path.edges, neighbor.edgeId],
      });
      queue.push(neighbor.nodeId);
    }
  }
  return pathsById;
};
