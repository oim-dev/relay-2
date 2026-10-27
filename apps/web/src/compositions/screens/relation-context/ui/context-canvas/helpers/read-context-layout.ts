import type { ElkNode } from "elkjs/lib/elk-api";
import type { XYPosition } from "@xyflow/react";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import type {
  ContextLayout,
  ContextLayoutNode,
  ContextLayoutEdge,
  ContextLayoutPlan,
  ContextNodeMove,
} from "../types/context-layout.type";
import type { ContextPort } from "../types/context-flow.type";

/**
 * Находит середину наиболее длинного горизонтального отрезка для подписи линии.
 */
const getLabelPosition = (points: XYPosition[]): XYPosition => {
  let longest = -1;
  let position = points[0] ?? { x: 0, y: 0 };
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1],
      end = points[index];
    if (!start || !end) continue;
    const score = start.y === end.y ? Math.abs(start.x - end.x) + 1000 : Math.abs(start.y - end.y);
    if (score <= longest) continue;
    longest = score;
    position = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  }
  return position;
};

/**
 * Переносит узлы, порты и маршруты одним смещением, удерживая выбранную карточку на месте.
 */
export const readContextLayout = (
  graph: ElkNode,
  plan: ContextLayoutPlan,
  anchor?: ContextNodeMove,
): ContextLayout => {
  const anchorNode = graph.children?.find((node) => node.id === anchor?.id);
  const shift =
    anchor && anchorNode
      ? { x: anchor.position.x - (anchorNode.x ?? 0), y: anchor.position.y - (anchorNode.y ?? 0) }
      : { x: 0, y: 0 };
  const nodes = new Map<string, ContextLayoutNode>();
  for (const node of graph.children ?? []) {
    if (!isDefined(node.x) || !isDefined(node.y))
      throw new Error("Раскладка не вернула координаты сущности.");
    const position = { x: node.x + shift.x, y: node.y + shift.y };
    const ports: ContextPort[] = (node.ports ?? []).map((port) => {
      const metadata = plan.ports.get(port.id);
      if (!metadata || !isDefined(port.x) || !isDefined(port.y))
        throw new Error("Раскладка не вернула точку подключения связи.");
      return { ...metadata, x: port.x, y: port.y };
    });
    nodes.set(node.id, { position, origin: position, ports });
  }
  const edges = new Map<string, ContextLayoutEdge>();
  for (const edge of graph.edges ?? []) {
    const points = (edge.sections ?? [])
      .flatMap((section) => [section.startPoint, ...(section.bendPoints ?? []), section.endPoint])
      .map((point) => ({ x: point.x + shift.x, y: point.y + shift.y }));
    if (!isNonEmptyArray(points))
      throw new Error("Раскладка не вернула маршрут сохранённой связи.");
    const sourcePortId = edge.sources[0],
      targetPortId = edge.targets[0];
    if (!sourcePortId || !targetPortId)
      throw new Error("Раскладка не вернула порты сохранённой связи.");
    edges.set(edge.id, {
      sourcePortId,
      targetPortId,
      points,
      labelPosition: getLabelPosition(points),
    });
  }
  return { nodes, edges, distances: plan.distances, parents: plan.parents };
};
