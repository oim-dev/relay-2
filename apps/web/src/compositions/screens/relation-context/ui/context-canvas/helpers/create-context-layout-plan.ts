import { Position } from "@xyflow/react";
import type { ElkExtendedEdge } from "elkjs/lib/elk-api";
import { getRelationPaths, relationAddress } from "domains/relations";
import type { RelationNode, RelationEdge } from "domains/relations";
import { CONTEXT_NODE_SIZE } from "../config/context-canvas.config";
import type { ContextParent, ContextLayoutPlan } from "../types/context-layout.type";
import type { ContextPort } from "../types/context-flow.type";
import type { ContextCanvasParams } from "../types/context-canvas-props.type";

/** Названия сторон в контракте ELK. */
const ELK_PORT_SIDES = {
  [Position.Left]: "WEST",
  [Position.Right]: "EAST",
  [Position.Top]: "NORTH",
  [Position.Bottom]: "SOUTH",
};

/**
 * Передаёт ELK основные пути дерева либо все связи с согласованными портами.
 */
export const createContextLayoutPlan = (
  nodes: RelationNode[],
  edges: RelationEdge[],
  root: string,
  view: ContextCanvasParams["view"],
  direction: ContextCanvasParams["direction"],
): ContextLayoutPlan => {
  const collator = new Intl.Collator("ru", { numeric: true });
  const sortedNodes = [...nodes].sort(
    (left, right) =>
      collator.compare(left.key, right.key) ||
      relationAddress(left.ref).localeCompare(relationAddress(right.ref)),
  );
  const pathsById = getRelationPaths(nodes, edges, root, direction);
  const distances = new Map<string, number>();
  const parents = new Map<string, ContextParent>();
  for (const [id, path] of pathsById) {
    distances.set(id, path.edges.length);
    const nodeId = path.nodes.at(-2),
      edgeId = path.edges.at(-1);
    if (nodeId !== undefined && edgeId !== undefined) parents.set(id, { nodeId, edgeId });
  }
  const treeEdgeIds = new Set([...parents.values()].map((parent) => parent.edgeId));
  const sortedEdges = edges
    .filter((edge) => view === "graph" || treeEdgeIds.has(edge.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const outsideDistance = Math.max(0, ...distances.values()) + 1;
  const ports = new Map<string, ContextPort>();
  const portsByNode = new Map<string, ContextPort[]>();
  const layoutEdges: ElkExtendedEdge[] = [];
  const isTree = view === "tree";
  for (const edge of sortedEdges) {
    const from = relationAddress(edge.from),
      to = relationAddress(edge.to);
    const fromDistance = distances.get(from) ?? outsideDistance;
    const toDistance = distances.get(to) ?? outsideDistance;
    const sourcePosition =
      fromDistance < toDistance
        ? Position.Right
        : fromDistance > toDistance
          ? Position.Left
          : Position.Top;
    const targetPosition =
      fromDistance < toDistance
        ? Position.Left
        : fromDistance > toDistance
          ? Position.Right
          : Position.Top;
    const portIds = {
      source: isTree ? `source:${from}:${sourcePosition}` : `source:${edge.id}`,
      target: isTree ? `target:${to}:${targetPosition}` : `target:${edge.id}`,
    };
    layoutEdges.push({ id: edge.id, sources: [portIds.source], targets: [portIds.target] });
    for (const type of ["source", "target"] as const) {
      if (ports.has(portIds[type])) continue;
      const nodeId = type === "source" ? from : to;
      const position = type === "source" ? sourcePosition : targetPosition;
      const port: ContextPort = {
        id: portIds[type],
        type,
        position,
        x: position === Position.Right ? CONTEXT_NODE_SIZE.width : 0,
        y: CONTEXT_NODE_SIZE.height / 2,
      };
      ports.set(port.id, port);
      portsByNode.set(nodeId, [...(portsByNode.get(nodeId) ?? []), port]);
    }
  }
  return {
    distances,
    parents,
    ports,
    graph: {
      id: "context",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.partitioning.activate": "true",
        "elk.layered.layering.strategy": "INTERACTIVE",
        "elk.layered.nodePlacement.strategy": "SIMPLE",
        "elk.layered.mergeEdges": String(isTree),
        "elk.spacing.nodeNode": "36",
        "elk.spacing.edgeNode": "24",
        "elk.spacing.edgeEdge": "14",
        "elk.layered.spacing.nodeNodeBetweenLayers": "120",
        "elk.layered.spacing.edgeNodeBetweenLayers": "24",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
        "elk.padding": "[top=40,left=40,bottom=40,right=40]",
      },
      children: sortedNodes.map((node, index) => {
        const id = relationAddress(node.ref);
        const distance = distances.get(id) ?? outsideDistance;
        return {
          id,
          ...CONTEXT_NODE_SIZE,
          x: distance * 500,
          y: index * 200,
          layoutOptions: {
            "elk.portConstraints": isTree ? "FIXED_POS" : "FIXED_SIDE",
            "elk.partitioning.partition": String(distance),
          },
          ports: (portsByNode.get(id) ?? []).map((port) => ({
            id: port.id,
            width: 0,
            height: 0,
            ...(isTree ? { x: port.x, y: port.y } : {}),
            layoutOptions: { "elk.port.side": ELK_PORT_SIDES[port.position] },
          })),
        };
      }),
      edges: layoutEdges,
    },
  };
};
