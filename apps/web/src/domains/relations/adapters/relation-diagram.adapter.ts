import { isDefined } from "shared/value-predicates";
import { relationAddress } from "../helpers/relation-address";
import { getRelations } from "./relations.adapter";
import {
  RELATION_DIAGRAM_MAX_PAGES,
  RELATION_DIAGRAM_PAGE_SIZE,
} from "../config/relation-diagram.config";
import type {
  RelationDiagram,
  RelationDiagramRequest,
  RelationDiagramBoundary,
} from "../types/relation-diagram.type";
import type { RelationNode, RelationEdge, RelationsPage } from "../types/relations.type";

/**
 * Собирает ограниченную выборку атомарно для UI: ни одна страница другого снимка не публикуется.
 */
export const getRelationDiagram = async (
  projectId: string,
  request: RelationDiagramRequest,
): Promise<RelationDiagram> => {
  const pageCount = request.regions.reduce((count, region) => count + region.pages, 0);
  if (pageCount > RELATION_DIAGRAM_MAX_PAGES) {
    throw new Error(
      "Достигнут предел визуального просмотра. Сузьте область или сделайте выбранную сущность исходной.",
    );
  }
  const initial = await getRelations(projectId, {
    root: request.root,
    depth: 0,
    limit: 1,
    version: request.version,
  });
  const root = initial.nodes[0];
  if (!isDefined(root)) {
    throw new Error("Исходная сущность не найдена в снимке графа.");
  }
  const version = initial.version;
  const rootAddress = relationAddress(root.ref);
  const nodesById = new Map<string, RelationNode>([[relationAddress(root.ref), root]]);
  const edgesById = new Map<string, RelationEdge>();
  const pathsById = new Map<string, RelationsPage["paths"][number]>();
  const boundaryIds = new Set<string>();
  const regions: RelationDiagramBoundary[] = [];

  for (const region of request.regions) {
    let offset: number | null = 0;
    let lastPage: RelationsPage | undefined;
    for (let pageIndex = 0; pageIndex < region.pages && offset !== null; pageIndex += 1) {
      const page = await getRelations(projectId, {
        root: region.root === request.root ? rootAddress : region.root,
        depth: region.depth,
        direction: request.direction,
        type: request.type,
        profile: "all",
        limit: RELATION_DIAGRAM_PAGE_SIZE,
        offset,
        version,
      });
      if (page.version !== version) {
        throw new Error("Граф изменился. Обновите весь просмотр.");
      }
      for (const node of [...page.nodes, ...page.endpoints]) {
        nodesById.set(relationAddress(node.ref), node);
      }
      for (const edge of page.edges) {
        edgesById.set(edge.id, edge);
      }
      if (region.root === request.root) {
        for (const path of page.paths) {
          pathsById.set(relationAddress(path.target), path);
        }
      }
      for (const ref of page.boundary) {
        boundaryIds.add(relationAddress(ref));
      }
      offset = page.nextOffset;
      lastPage = page;
    }
    if (isDefined(lastPage)) {
      regions.push({
        ...region,
        nextOffset: offset,
        totalNodes: lastPage.totalNodes,
        totalEdges: lastPage.totalEdges,
        isDepthLimited: lastPage.depthLimited,
      });
    }
  }
  return {
    root,
    version,
    nodes: [...nodesById.values()],
    edges: [...edgesById.values()],
    paths: [...pathsById.values()],
    regions,
    boundary: [...boundaryIds],
  };
};
