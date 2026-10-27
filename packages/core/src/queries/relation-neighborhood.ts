import {
  RelayError,
  type RelationNeighborhood,
  type RelationNeighborhoodRequest,
  type RelationViewPath,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { relationIndex } from "./relation-source";
import { viewQuery, viewPage, viewText, viewGeneration } from "./view-page";
import type { RelationStep } from "./relation-neighborhood.types";
import { relationViewMessages } from "./relation-neighborhood.messages";

/**
 * Читает одно bounded окно соседства из согласованного metadata-графа.
 * Пока O(N+E) metadata загружаются для входящих связей, без текстов и журналов;
 * один индекс и BFS на вызов, сортировка O(N log N + E log E). Результат ограничен
 * limit узлами, limit рёбрами, их endpoints и путями не длиннее depth<=100.
 */
export function readRelationNeighborhood(
  db: ProjectStore,
  request: RelationNeighborhoodRequest = {},
): RelationNeighborhood {
  const input = viewQuery(request, [
    "ref",
    "component",
    "depth",
    "direction",
    "type",
    "q",
    "offset",
    "limit",
    "generation",
  ]);
  const component = input.component === undefined ? false : input.component;
  if (typeof component !== "boolean") {
    throw new RelayError("INVALID_ARGUMENT", relationViewMessages.options, 2);
  }
  const page = viewPage(input);
  const ref = viewText(input.ref);
  const type = viewText(input.type);
  const q = viewText(input.q)?.toLocaleLowerCase();
  const depth = input.depth === undefined ? 3 : input.depth;
  const direction = input.direction === undefined ? "both" : input.direction;
  if (
    typeof depth !== "number" ||
    !Number.isInteger(depth) ||
    depth < 0 ||
    depth > 100 ||
    (direction !== "both" && direction !== "incoming" && direction !== "outgoing")
  ) {
    throw new RelayError("INVALID_ARGUMENT", relationViewMessages.options, 2);
  }
  return db.snapshot(() => {
    const generation = viewGeneration(db, page.generation);
    const root = ref === undefined ? null : new EntityService(db).resolve(ref);
    const index = relationIndex(db.listGraphSources("relations"));
    const edges = index.edges.filter((edge) => type === undefined || edge.type === type);
    const adjacency = new Map<string, RelationStep[]>();
    for (const edge of edges) {
      if (direction !== "incoming") {
        const list = adjacency.get(edge.from.id) ?? [];
        list.push({ id: edge.to.id, edge: edge.id });
        adjacency.set(edge.from.id, list);
      }
      if (direction !== "outgoing") {
        const list = adjacency.get(edge.to.id) ?? [];
        list.push({ id: edge.from.id, edge: edge.id });
        adjacency.set(edge.to.id, list);
      }
    }
    const distance = new Map<string, number>();
    const parent = new Map<string, RelationStep>();
    const queue = root === null ? [] : [root.id];
    if (root !== null) {
      distance.set(root.id, 0);
    }
    for (const id of queue) {
      const level = distance.get(id) ?? 0;
      if (!component && level === depth) {
        continue;
      }
      for (const next of adjacency.get(id) ?? []) {
        if (!distance.has(next.id)) {
          distance.set(next.id, level + 1);
          parent.set(next.id, { id, edge: next.edge });
          queue.push(next.id);
        }
      }
    }
    const reachable = new Set(root === null ? index.nodes.keys() : distance.keys());
    const boundary = new Set(
      [...reachable].filter((id) =>
        (adjacency.get(id) ?? []).some((next) => !reachable.has(next.id)),
      ),
    );
    const nodes = [...index.nodes.values()]
      .filter(
        (node) =>
          reachable.has(node.ref.id) &&
          (q === undefined ||
            `${node.key} ${node.title} ${node.ref.kind}:${node.ref.id}`
              .toLocaleLowerCase()
              .includes(q)),
      )
      .sort((a, b) => a.key.localeCompare(b.key) || a.ref.id.localeCompare(b.ref.id));
    const selected = new Set(nodes.map((node) => node.ref.id));
    const selectedEdges = edges.filter(
      (edge) => selected.has(edge.from.id) && selected.has(edge.to.id),
    );
    const pageNodes = nodes.slice(page.offset, page.offset + page.limit);
    const pageEdges = selectedEdges.slice(page.offset, page.offset + page.limit);
    const endpoints = new Set(pageEdges.flatMap((edge) => [edge.from.id, edge.to.id]));
    for (const node of pageNodes) {
      endpoints.delete(node.ref.id);
    }
    const paths: RelationViewPath[] =
      root === null || component
        ? []
        : pageNodes.map((node) => {
            const ids = [node.ref.id];
            const pathEdges: string[] = [];
            let step = parent.get(node.ref.id);
            while (step) {
              ids.push(step.id);
              pathEdges.push(step.edge);
              step = parent.get(step.id);
            }
            return {
              target: node.ref,
              nodes: ids.reverse().map((id) => {
                const item = index.nodes.get(id);
                if (!item) {
                  throw new RelayError("CORRUPT_DATA", relationViewMessages.corrupt, 1, { id });
                }
                return item.ref;
              }),
              edges: pathEdges.reverse(),
            };
          });
    return {
      root: root === null ? null : { id: root.id, kind: root.kind },
      nodes: pageNodes,
      edges: pageEdges,
      endpoints: nodes.filter((node) => endpoints.has(node.ref.id)),
      paths,
      totalNodes: nodes.length,
      totalEdges: selectedEdges.length,
      nextOffset:
        page.offset + page.limit < Math.max(nodes.length, selectedEdges.length)
          ? page.offset + page.limit
          : null,
      boundary: pageNodes.filter((node) => boundary.has(node.ref.id)).map((node) => node.ref),
      depthLimited: boundary.size > 0,
      generation,
    };
  });
}
